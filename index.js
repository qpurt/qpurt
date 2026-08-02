// QPURT API
import fs from 'node:fs';
import path from 'node:path';
import pkg from "./package.json" with { type: 'json' };
import file_exists from './lib/fs/file_exists.js';

const _config = {
  dir: {
    static: false,
    functions: false
  },
  watch: true, 
  routes: [
    { url: '/', func: 'somefunc' },
    { url: '/other', func: 'somefunc' }
  ]
};

export function server() {

  return {

    start: async function(config=startConfig) {

      const static_dir = path.resolve('public');
      const functions_dir = path.resolve('funcs');
      
      // Static Dir Checker
      if (await file_exists(static_dir)) {
        console.log('static dir exists...')
        // RUN STATIC ROUTES
      } else {
        console.log('static dir does not exists...')
      }

      // Functions Dir Checker
      if (await file_exists(functions_dir)) {
        // RUN BACKEND ROUTES
        console.log('functions dir exists...')
      } else {
        console.log('functions dir does not exists...')
      }


      if (config.watch) {
        console.log('watch file changes in development mode...')
      } else {
        console.log('start server in production mode...')
      }

      console.log(startConfig.routes)

      return console.log(`start() still processing data. no return yet...`)
    }

  }
  
};