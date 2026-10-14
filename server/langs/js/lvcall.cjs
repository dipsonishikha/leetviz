// The tracer pauses on this `debugger` statement, then steps into the solution.
module.exports = function lvCall(f, args) {
  debugger;
  return f(...args);
};
