#!/usr/bin/env node

var Liftoff = require('liftoff');
var argv = require('minimist')(process.argv.slice(2));
var path = require('path');
var cli = new Liftoff({
  name: 'fis3',
  processTitle: 'fis',
  moduleName: 'fis3',
  configName: 'fis-conf',

  // only js supported!
  extensions: {
    '.js': null
  }
});

cli.launch({
  cwd: argv.r || argv.root,
  configPath: argv.f || argv.file
}, function(env) {
  // 优先查找cwd的node_modules下的fis3，
  // 如果没有找到则查找cwd上一级的node_modules下的fis3
  // 直至root
  var fis;
  if (!env.modulePath) {
    fis = require('../');
  // 如果root没有，则使用全局的node_modules下的fis3
  } else {
    fis = require(env.modulePath);
  }

  process.title = this.name +' ' + process.argv.slice(2).join(' ') + ' [ ' + env.cwd + ' ]';

  // 配置fis.require查找plugin的路径
  // 优先查找本地项目里面的 node_modules
  // 然后才是当前使用的fis3 目录里面的 node_modules
  fis.require.paths.unshift(path.join(env.cwd, 'node_modules'));
  fis.require.paths.push(path.join(path.dirname(__dirname), 'node_modules'));
  fis.cli.name = this.name;
  fis.cli.run(argv, env);
});
