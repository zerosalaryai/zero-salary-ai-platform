/* eslint-disable @typescript-eslint/no-require-imports -- Node --require preload must execute before ESM/tsx imports. */
const deny=()=>{throw new Error('SYNTHETIC_NETWORK_BLOCKED');};
global.fetch=deny;
require('node:net').Socket.prototype.connect=deny;
require('node:http').request=deny;
require('node:https').request=deny;
