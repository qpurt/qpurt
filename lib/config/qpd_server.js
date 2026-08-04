export default {
  port: 3000,
  static: 'public',
  functions: 'functions',
  watch: true, 
  routes: [
    { url: '/', func: 'somefunc' },
    { url: '/other', func: 'somefunc' }
  ]
};