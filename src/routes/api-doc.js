
import fs from 'fs';
import path from 'path';
import {Router} from 'express';

export default function () {
  const apiDoc = fs.readFileSync(path.join(import.meta.dirname, '..', 'api.yaml'), 'utf8');

  return new Router()
    .get('/', (req, res) => {
      res.set('Content-Type', 'application/yaml');
      res.send(apiDoc);
    });
}
