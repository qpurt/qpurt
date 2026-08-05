# qpurt

**Lightweight, zero dependency Node.js server library.**

Still in development.

~~~shell
npm install qpurt
~~~

~~~js
import { server } from 'qpurt';

// Any one of the following options would work.
// You can also place your config in package.json.qpConfig.server

server({
    "port": 4000,
    "static": "public",
    "functions": "func",
    "watch": true,
    "watchPaths": [],
    "watchIgnore": [],
    "watchExtensions": [],
    "routes": []
}).start();

// If you have a "qpurt.json" at the root directory
// or in package.json
server().start();

server('qpurt.json').start();
~~~