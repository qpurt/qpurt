import { server } from '../index.js';

const myServer = server();

myServer.start({ watch:false });