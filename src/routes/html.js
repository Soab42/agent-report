// src/routes/html.js
// Serves the static dashboard from public/.

import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function htmlRouter() {
  const router = express.Router();
  const publicDir = path.join(__dirname, '..', '..', 'public');
  router.use(express.static(publicDir, { extensions: ['html'], maxAge: '1h' }));
  router.get('/', (_req, res) => res.sendFile(path.join(publicDir, 'index.html')));
  return router;
}
