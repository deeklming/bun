"use strict";

const { validateAbortSignal, validateInteger, validateObject } = require("internal/validators");
const { kWeakHandler, kResistStopPropagation } = require("internal/shared");
const { finished } = require("internal/streams/end-of-stream");
const staticCompose = require("internal/streams/compose");
const { addAbortSignalNoValidate } = require("internal/streams/add-abort-signal");
const { isWritable, isNodeStream } = require("internal/streams/utils");

const MathFloor = Math.floor;
const PromiseResolve = Promise.resolve.bind(Promise);
const PromiseReject = Promise.reject.bind(Promise);
const PromisePrototypeThen = Promise.prototype.then;
const ArrayPrototypePush = Array.prototype.push;
const NumberIsNaN = Number.isNaN;
const ObjectDefineProperty = Object.defineProperty;

const kEmpty = Symbol("kEmpty");
const kEof = Symbol("kEof");

function compose(stream, options) {
  if (options != null) {
    validateObject(options, "options");
  }
  if (options?.signal != null) {
    validateAbortSignal(options.signal, "options.signal");
  }

  if (isNodeStream(stream) && !isWritable(stream)) {
    throw $ERR_INVALID_ARG_VALUE("stream", stream, "must be writable");
  }

  const composedStream = staticCompose(this, stream);

  if (options?.signal) {
    // Not validating as we already validated before
    addAbortSignalNoValidate(options.signal, composedStream);
  }

  return composedStream;
}

function map(fn, options) {
  if (typeof fn !== "function") {
    throw $ERR_INVALID_ARG_TYPE("fn", ["Function", "AsyncFunction"], fn);
  }
  if (options != null) {
    validateObject(options, "options");
  }
  if (options?.signal != null) {
    validateAbortSignal(options.signal, "options.signal");
  }

  let concurrency = 1;
  if (options?.concurrency != null) {
    concurrency = MathFloor(options.concurrency);
  }

  let highWaterMark = concurrency - 1;
  if (options?.highWaterMark != null) {
    highWaterMark = MathFloor(options.highWaterMark);
  }

  validateInteger(concurrency, "options.concurrency", 1);
  validateInteger(highWaterMark, "options.highWaterMark", 0);

  highWaterMark += concurrency;

  return async function* map() {
    const signal = AbortSignal.any([options?.signal].filter(Boolean));
    const stream = this;
    const queue: (Promise<any> | typeof kEof)[] = [];
    const signalOpt = { signal };

    let next;
    let resume;
    let done = false;
    let cnt = 0;

    function onCatch() {
      done = true;
      afterItemProcessed();
    }

    function afterItemProcessed() {
      cnt -= 1;
      maybeResume();
    }

    function maybeResume() {
      if (resume && !done && cnt < concurrency && queue.length < highWaterMark) {
        resume();
        resume = null;
      }
    }

    async function pump() {
      try {
        for await (let val of stream) {
          if (done) {
            return;
          }

          if (signal.aborted) {
            throw $makeAbortError();
          }

          try {
            val = fn(val, signalOpt);

            if (val === kEmpty) {
              continue;
            }

            val = PromiseResolve(val);
          } catch (err) {
            val = PromiseReject(err);
          }

          cnt += 1;

          PromisePrototypeThen.$call(val, afterItemProcessed, onCatch);

          queue.push(val);
          if (next) {
            next();
            next = null;
          }

          if (!done && (queue.length >= highWaterMark || cnt >= concurrency)) {
            await new Promise(resolve => {
              resume = resolve;
            });
          }
        }
        queue.push(kEof);
      } catch (err) {
        const val = PromiseReject(err);
        PromisePrototypeThen.$call(val, afterItemProcessed, onCatch);
        queue.push(val);
      } finally {
        done = true;
        if (next) {
          next();
          next = null;
        }
      }
    }

    pump();

    try {
      while (true) {
        while (queue.length > 0) {
          const val = await queue[0];

          if (val === kEof) {
            return;
          }

          if (signal.aborted) {
            throw $makeAbortError();
          }

          if (val !== kEmpty) {
            yield val;
          }

          queue.shift();
          maybeResume();
        }

        await new Promise(resolve => {
          next = resolve;
        });
      }
    } finally {
      done = true;
      if (resume) {
        resume();
        resume = null;
      }
    }
  }.$call(this);
}

async function some(fn, options = undefined) {
  for await (const unused of filter.$call(this, fn, options)) {
    return true;
  }
  return false;
}

async function every(fn, options = undefined) {
  if (typeof fn !== "function") {
    throw $ERR_INVALID_ARG_TYPE("fn", ["Function", "AsyncFunction"], fn);
  }
  // https://en.wikipedia.org/wiki/De_Morgan's_laws
  return !(await some.$call(
    this,
    async (...args) => {
      return !(await fn(...args));
    },
    options,
  ));
}

async function find(fn, options) {
  for await (const result of filter.$call(this, fn, options)) {
    return result;
  }
  return undefined;
}

async function forEach(fn, options) {
  if (typeof fn !== "function") {
    throw $ERR_INVALID_ARG_TYPE("fn", ["Function", "AsyncFunction"], fn);
  }
  async function forEachFn(value, options) {
    await fn(value, options);
    return kEmpty;
  }
  // eslint-disable-next-line no-unused-vars
  for await (const unused of map.$call(this, forEachFn, options));
}

function filter(fn, options) {
  if (typeof fn !== "function") {
    throw $ERR_INVALID_ARG_TYPE("fn", ["Function", "AsyncFunction"], fn);
  }
  async function filterFn(value, options) {
    if (await fn(value, options)) {
      return value;
    }
    return kEmpty;
  }
  return map.$call(this, filterFn, options);
}

// Specific to provide better error to reduce since the argument is only
// missing if the stream has no items in it - but the code is still appropriate
class ReduceAwareErrMissingArgs extends TypeError {
  constructor() {
    super("reduce");
    this.code = "ERR_MISSING_ARGS";
    this.message = "Reduce of an empty stream requires an initial value";
  }
}

async function reduce(reducer, initialValue, options) {
  if (typeof reducer !== "function") {
    throw $ERR_INVALID_ARG_TYPE("reducer", ["Function", "AsyncFunction"], reducer);
  }
  if (options != null) {
    validateObject(options, "options");
  }
  if (options?.signal != null) {
    validateAbortSignal(options.signal, "options.signal");
  }

  let hasInitialValue = arguments.length > 1;
  if (options?.signal?.aborted) {
    const err = $makeAbortError(undefined, { cause: options.signal.reason });
    this.once("error", () => {}); // The error is already propagated
    await finished(this.destroy(err));
    throw err;
  }
  const ac = new AbortController();
  const signal = ac.signal;
  if (options?.signal) {
    const opts = { once: true, [kWeakHandler]: this, [kResistStopPropagation]: true };
    options.signal.addEventListener("abort", () => ac.abort(), opts);
  }
  let gotAnyItemFromStream = false;
  try {
    for await (const value of this) {
      gotAnyItemFromStream = true;
      if (options?.signal?.aborted) {
        throw $makeAbortError();
      }
      if (!hasInitialValue) {
        initialValue = value;
        hasInitialValue = true;
      } else {
        initialValue = await reducer(initialValue, value, { signal });
      }
    }
    if (!gotAnyItemFromStream && !hasInitialValue) {
      throw new ReduceAwareErrMissingArgs();
    }
  } finally {
    ac.abort();
  }
  return initialValue;
}

async function toArray(options) {
  if (options != null) {
    validateObject(options, "options");
  }
  if (options?.signal != null) {
    validateAbortSignal(options.signal, "options.signal");
  }

  const result = [];
  for await (const val of this) {
    if (options?.signal?.aborted) {
      throw $makeAbortError(undefined, { cause: options.signal.reason });
    }
    ArrayPrototypePush.$call(result, val);
  }
  return result;
}

function flatMap(fn, options) {
  const values = map.$call(this, fn, options);
  async function* flatMapInner() {
    for await (const val of values) {
      yield* val;
    }
  }
  return flatMapInner.$call(this);
}

function toIntegerOrInfinity(number) {
  // We coerce here to align with the spec
  // https://github.com/tc39/proposal-iterator-helpers/issues/169
  number = Number(number);
  if (NumberIsNaN(number)) {
    return 0;
  }
  if (number < 0) {
    throw $ERR_OUT_OF_RANGE("number", ">= 0", number);
  }
  return number;
}

function drop(number, options?) {
  if (options != null) {
    validateObject(options, "options");
  }
  if (options?.signal != null) {
    validateAbortSignal(options.signal, "options.signal");
  }

  number = toIntegerOrInfinity(number);
  return async function* drop() {
    if (options?.signal?.aborted) {
      throw $makeAbortError();
    }
    for await (const val of this) {
      if (options?.signal?.aborted) {
        throw $makeAbortError();
      }
      if (number-- <= 0) {
        yield val;
      }
    }
  }.$call(this);
}
ObjectDefineProperty(drop, "length", { value: 1 });

function take(number, options?: { signal: AbortSignal }) {
  if (options != null) {
    validateObject(options, "options");
  }
  if (options?.signal != null) {
    validateAbortSignal(options.signal, "options.signal");
  }

  number = toIntegerOrInfinity(number);
  return async function* take() {
    if (options?.signal?.aborted) {
      throw $makeAbortError();
    }
    for await (const val of this) {
      if (options?.signal?.aborted) {
        throw $makeAbortError();
      }
      if (number-- > 0) {
        yield val;
      }

      // Don't get another item from iterator in case we reached the end
      if (number <= 0) {
        return;
      }
    }
  }.$call(this);
}
ObjectDefineProperty(take, "length", { value: 1 });

export default {
  streamReturningOperators: {
    drop,
    filter,
    flatMap,
    map,
    take,
    compose,
  },
  promiseReturningOperators: {
    every,
    forEach,
    reduce,
    toArray,
    some,
    find,
  },
};
