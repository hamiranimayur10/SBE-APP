const express = require('express');
const app = express();

app.use(require('./badminton-backend/server'));

module.exports = app;
