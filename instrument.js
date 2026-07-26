const Sentry = require("@sentry/node");

Sentry.init({
  dsn: "https://80f28dc3bfe42a79317da2657cfd79be@o4511801971507200.ingest.us.sentry.io/4511801971507200",
  // Envia uma amostra das transações de performance também (10% delas)
  tracesSampleRate: 0.1,
});

module.exports = Sentry;
