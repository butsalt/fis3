'use strict';

var CACHE_DIR;
var _ = require('./util.js');
var rType = /\s+type\s*=\s*(['"]?)((?:text|application)\/(.*?))\1/i;
var memoryCache = {};
var compileStack = [];
var path = require('path');

// 待编译完成后，清空内存缓存
fis.on('release:end', function() {
  memoryCache = {};
  compileStack = [];
});
fis.on('release:error', function() {
  memoryCache = {};
  compileStack = [];
});

function revertFromMemory(file, inCache) {
  file.revertFromCacheData(inCache.getCacheData());
  file.cache = inCache.cache;
  file.setContent(inCache.getContent());
};

/**
 * 编译相关函数入口, 输入为 文件对象，没有输出，直接修改文件对象内容。
 *
 * 默认文件编译会尝试从缓存中读取，如果缓存有效，将跳过编译。
 *
 * @example
 * var file = fis.file(filepath);
 * fis.compile(file);
 * console.log(file.getContent());
 *
 * @function
 * @param {String} file 文件对象
 * @namespace fis.compile
 */
var exports = module.exports = function(file, context) {
  if (!CACHE_DIR) {
    fis.log.error('uninitialized compile cache directory.');
  }
  file = fis.file.wrap(file);

  if (!file.realpath) {
    error('unable to compile [' + file.subpath + ']: Invalid file realpath.');
  }

  if (file.useCache && memoryCache[file.realpath]) {
    // memoryCache中存在就直接使用memoryCache中对应文件的缓存来恢复
    // 因为是本次release任务中的cache，原文件内容不可能发生变化，可以直接使用
    revertFromMemory(file, memoryCache[file.realpath]);
    return file;
  }

  // 只有启用 cache 的时候才存入 memoryCache
  file.useCache && (memoryCache[file.realpath] = file);

  // lint 置前，不使用文件缓存
  if (file.isText() && exports.settings.useLint) {
    pipe(file, 'lint', true);
  }

  // 如果文件内容里有__RESOURCE_MAP__，那就关闭缓存，并标记需要替换内容中的__RESOURCE_MAP__
  adjust(file);

  fis.log.debug('compile [' + file.realpath + '] start');
  fis.emit('compile:start', file);
  ~compileStack.indexOf(file.realpath) || compileStack.push(file.realpath);
  if (file.isFile()) {
    // 需要编译的文件才使用缓存
    if (file.useCompile && file.ext && file.ext !== '.') {
      // 使用缓存文件生成缓存实例
      // 缓存文件保存在：临时目录/cache/compile/release-dev/文件去后缀的名字*
      var cache = file.cache = fis.cache(file.realpath, CACHE_DIR),
        revertObj = {};
      // 如果开启了缓存，尝试将缓存内的信息写入revertObj
      if (file.useCache && cache.revert(revertObj)) {
        // 缓存有效
        exports.settings.beforeCacheRevert(file);
        // 将编译信息写回到file
        file.revertFromCacheData(revertObj.info);
        if (file.isText()) {
          // 将二进制数据还原成字符串
          revertObj.content = revertObj.content.toString('utf8');
        }
        // 设置文件内容
        file.setContent(revertObj.content);
        exports.settings.afterCacheRevert(file);
      } else {
        // 缓存失效，重新编译
        exports.settings.beforeCompile(file);
        file.setContent(fis.util.read(file.realpath));
        process(file);
        exports.settings.afterCompile(file);
        fis.log.debug('Save cache [%s] start', file.subpath);
        // 将信息写入到缓存
        file.useCache && cache.save(file.getContent(), file.getCacheData());
        fis.log.debug('Save cache [%s] end', file.subpath);
      }
    } else {
      file.setContent(file.isText() ? fis.util.read(file.realpath) : fis.util.fs.readFileSync(file.realpath));
    }
  } else if (file.useCompile && file.ext && file.ext !== '.') {
    process(file, context);
  }
  if (file.useHash) {
    // 产出文件需要hash，根据内容计算md5
    file.getHash();
  }
  file.compiled = true;
  fis.log.debug('compile [' + file.realpath + '] end');
  fis.emit('compile:end', file);

  // 是文件变化触发的重新编译，不进入相关文件编译。
  context && context.fromWatch || file.links.forEach(function(subpath) {
    var f = fis.file.wrap(fis.project.getProjectPath() + subpath);

    if (f.exists() && !~compileStack.indexOf(f.realpath)) {
      compileStack.push(f.realpath);
      fis.emit('compile:add', f);
    }
  });

  compileStack.pop();
  return file;
};

/**
 * fis 编译默认的配置项
 * @property {Boolean} debug 如果设置成了 true, 那么编译缓存将会使用 debug 文件夹来存储缓存。
 * @property {Function} beforeCacheRevert 当文件从缓存中还原回来前执行。
 * @property {Function} afterCacheRevert 当文件从缓存中还原回来后执行。
 * @property {Function} beforeCompile 当文件开始编译前执行。
 * @property {Function} afterCompile 当文件开始编译后执行。
 * @name settings
 * @memberOf fis.compile
 */
exports.settings = {
  debug: false,
  useLint: false,
  beforeCacheRevert: function() {},
  afterCacheRevert: function() {},
  beforeCompile: function() {},
  afterCompile: function() {}
};

/**
 * 在编译前，初始化配置项。关于配置项，请查看 {@link fis.compile.settings}
 * @param  {Object} opt
 * @return {String}     缓存文件夹路径
 * @memberOf fis.compile
 * @name setup
 * @function
 */
exports.setup = function(opt) {
  var settings = exports.settings;
  if (opt) {
    fis.util.map(settings, function(key) {
      // 命令行中相关的配置覆盖默认编译配置
      if (typeof opt[key] !== 'undefined') {
        settings[key] = opt[key];
      }
    });
  }

  // 定义缓存目录
  CACHE_DIR = 'compile/';
  if (settings.unique) {
    // compile/1486696938692-0.34
    CACHE_DIR += Date.now() + '-' + Math.random();
  } else {
    // compile/release-dev
    CACHE_DIR += '' + (settings.debug ? 'debug' : 'release') + '-' + fis.project.currentMedia();
  }

  return CACHE_DIR;
};

/**
 * 清除缓存
 * @param  {String} name 想要清除的缓存目录，缺省为清除默认缓存或全部缓存
 * @memberOf fis.compile
 * @name clean
 * @function
 */
exports.clean = function(name) {
  if (name) {
    fis.cache.clean('compile/' + name);
  } else if (CACHE_DIR) {
    fis.cache.clean(CACHE_DIR);
  } else {
    fis.cache.clean('compile');
  }
};


/**
 * fis 中间码管理器。
 * @namespace fis.compile.lang
 */
var map = exports.lang = (function() {
  var keywords = [];
  // 分隔符
  var delim = '\u001F'; // Unit Separator
  var rdelim = '\\u001F';
  var slice = [].slice;
  // 为真值时说明add过，需要重新生成reg
  var regInvalid = false;
  var reg = null;
  var map = {

    /**
     * 添加其他中间码类型。
     * @param {String} type 类型
     * @function add
     * @memberOf fis.compile.lang
     */
    add: function(type) {
      // 已经add的type就不再add
      if (~keywords.indexOf(type)) {
        return this;
      }
      var stack = [];
      keywords.push(type);
      regInvalid = true;
      map[type] = {
        wrap: function(value) {
          return this.ld + slice.call(arguments, 0).join(delim) + this.rd;
        }
      };

      // 定义map.ld
      Object.defineProperty(map[type], 'ld', {
        get: function() {
          var depth = stack.length;
          stack.push(depth);
          return delim + type + depth + delim;
        }
      });

      // 定义map.rd
      Object.defineProperty(map[type], 'rd', {
        get: function() {
          return delim + stack.pop() + type + delim;
        }
      });
    }
  };

  /**
   * 获取能识别中间码的正则
   * @name reg
   * @type {RegExp}
   * @memberOf fis.compile.lang
   */
  Object.defineProperty(map, 'reg', {
    get: function() {
      if (regInvalid || !reg) {
        reg = new RegExp(
          // $1 type
          // $2 stack.length
          // $3 value
          // $4 extraValue
          rdelim + '(' + keywords.join('|') + ')(\\d+?)' + rdelim + '([^' + rdelim + ']*?)(?:' + rdelim + '([^' + rdelim + ']*?))?' + rdelim + '\\2\\1' + rdelim,
          'g'
        );
        regInvalid = false;
      }

      return reg;
    }
  });

  // 默认支持的中间码
  [
    'require', // 同步依赖文件。
    'jsRequire', // 同步 js 依赖
    'embed', // 内嵌其他文件
    'jsEmbed', // 内嵌 js 文件内容
    'async', // 异步依赖
    'jsAsync', // js 异步依赖
    'uri', // 替换成目标文件的 url
    'dep', // 简单的标记依赖
    'id', // 替换成目标文件的 id
    'hash', // 替换成目标文件的 md5 戳。
    'moduleId', // 替换成目标文件的 moduleId
    'xlang', // 用来内嵌其他语言
    'inlineStyle', // 内联样式
    'sourceMap',
    'info' // 能用来包括其他中间码，包裹后可以起到其他中间码的作用，但是不会修改代码源码。
  ].forEach(map.add);

  return map;
})();

/**
 * 判断info.query是否为inline
 *
 * - `abc?__inline` return true
 * - `abc?__inlinee` return false
 * - `abc?a=1&__inline'` return true
 * - `abc?a=1&__inline=` return true
 * - `abc?a=1&__inline&` return true
 * - `abc?a=1&__inline` return true
 * @param {Object} info
 * @memberOf fis.compile
 */
function isInline(info) {
  return /[?&]__inline(?:[=&'"]|$)/.test(info.query);
}

/**
 * 分析注释中依赖用法。
 * @param {String} comment 注释内容
 * @param {Callback} [callback] 可以通过此参数来替换原有替换回调函数。
 * @memberOf fis.compile
 */
function analyseComment(comment, callback) {
  var reg = /(@(require|async|require\.async)\s+)('[^']+'|"[^"]+"|[^\s;!@#%^&*()]+)/g;
  callback = callback || function(m, prefix, type, value) {
    type = type === 'require' ? type : 'async';

    return prefix + map[type].wrap(value);
  };

  // 如果有sourceMap也无非是对应某个.map结尾的文件
  // 需要申明本文件对该文件的依赖，并对uri做调整
  return comment.replace(reg, callback).replace(/(?:@|#)\s+sourceMappingURL=([^\s]+)/g, function(_, value) {
    return '# sourceMappingURL=' + map.sourceMap.wrap(value);
  });
}

/**
 * 标准化处理 javascript 内容, 识别 __inline、__uri 和 __require 的用法，并将其转换成中间码。
 *
 * - [@require id] in comment to require resource
 * - __inline(path) to embedd resource content or base64 encodings
 * - __uri(path) to locate resource
 * - require(path) to require resource
 *
 * @param {String} content js 内容
 * @param {Callback} callback 正则替换回调函数，如果不想替换，请传入 null.
 * @param {File} file js 内容所在文件。
 * @memberOf fis.compile
 */
function extJs(content, callback, file) {
  var reg = /"(?:[^\\"\r\n\f]|\\[\s\S])*"|'(?:[^\\'\n\r\f]|\\[\s\S])*'|(\/\/[^\r\n\f]+|\/\*[\s\S]*?(?:\*\/|$))|\b(__inline|__uri|__require|__id|__moduleId|__hash)\s*\(\s*("(?:[^\\"\r\n\f]|\\[\s\S])*"|'(?:[^\\'\n\r\f]|\\[\s\S])*')\s*\)/g;
  callback = callback || function(m, comment, type, value) {
    if (type) {
      switch (type) {
        case '__inline':
          m = map.jsEmbed.wrap(value);
          break;
        case '__uri':
          m = map.uri.wrap(value);
          break;
        case '__id':
          m = map.id.wrap(value);
          break;
        case '__moduleId':
          m = map.moduleId.wrap(value);
          break;
        case '__require':
          m = 'require(' + map.jsRequire.wrap(value) + ')';
          break;
        case '__hash':
          m = map.hash.wrap(value);
          break;
      }
    } else if (comment) {
      m = analyseComment(comment);
    }
    return m;
  };
  content = content.replace(reg, callback);
  var info = {
    file: file,
    content: content
  };

  fis.emit('standard:js', info);
  return info.content;
}

/**
 * 标准化处理 css 内容, 识别各种外链用法，并将其转换成中间码。
 *
 * - [@require id] in comment to require resource
 * - [@import url(path?__inline)] to embed resource content
 * - url(path) to locate resource
 * - url(path?__inline) to embed resource content or base64 encodings
 * - src=path to locate resource
 *
 * @param {String} content css 内容。
 * @param {Callback} callback 正则替换回调函数，如果不想替换，请传入 null.
 * @param {File} file js 内容所在文件。
 * @memberOf fis.compile
 */
function extCss(content, callback, file) {
  var reg = /(\/\*[\s\S]*?(?:\*\/|$))|(?:@import\s+)?\burl\s*\(\s*("(?:[^\\"\r\n\f]|\\[\s\S])*"|'(?:[^\\'\n\r\f]|\\[\s\S])*'|[^)}\s]+)\s*\)(\s*;?)|\bsrc\s*=\s*("(?:[^\\"\r\n\f]|\\[\s\S])*"|'(?:[^\\'\n\r\f]|\\[\s\S])*'|[^\s}]+)/g;
  callback = callback || function(m, comment, url, last, filter) {
    if (url) {
      var key = isInline(fis.util.query(url)) ? 'embed' : 'uri';
      if (m.indexOf('@') === 0) {
        if (key === 'embed') {
          m = map.embed.wrap(url) + last.replace(/;$/, '');
        } else {
          m = '@import url(' + map.uri.wrap(url) + ')' + last;
        }
      } else {
        m = 'url(' + map[key].wrap(url) + ')' + last;
      }
    } else if (filter) {
      m = 'src=' + map.uri.wrap(filter);
    } else if (comment) {
      m = analyseComment(comment);
    }
    return m;
  };
  content = content.replace(reg, callback);

  var info = {
    file: file,
    content: content
  };

  fis.emit('standard:css', info);

  return info.content;
}

/**
 * 标准化处理 html 内容, 识别各种语法，并将其转换成中间码。
 *
 * - `<!--inline[path]-->` to embed resource content
 * - `<img|embed|audio|video|link|object ... (data-)?src="path"/>` to locate resource
 * - `<img|embed|audio|video|link|object ... (data-)?src="path?__inline"/>` to embed resource content
 * - `<script|style ... src="path"></script|style>` to locate js|css resource
 * - `<script|style ... src="path?__inline"></script|style>` to embed js|css resource
 * - `<script|style ...>...</script|style>` to analyse as js|css
 *
 * @param {String} content html 内容。
 * @param {Callback} callback 正则替换回调函数，如果不想替换，请传入 null.
 * @param {File} file js 内容所在文件。
 * @memberOf fis.compile
 */
function extHtml(content, callback, file) {
  var reg = /(<script(?:(?=\s)[\s\S]*?["'\s\w\/\-]>|>))([\s\S]*?)(?=<\/script\s*>|$)|(<style(?:(?=\s)[\s\S]*?["'\s\w\/\-]>|>))([\s\S]*?)(?=<\/style\s*>|$)|<(img|embed|audio|video|link|object|source)\s+[\s\S]*?["'\s\w\/\-](?:>|$)|<!--inline\[([^\]]+)\]-->|(<!(?:--)?\[[^>]+>)|<!--(?!\[|>)([\s\S]*?)(-->|$)|\bstyle\s*=\s*("(?:[^\\"\r\n\f]|\\[\s\S])+"|'(?:[^\\'\n\r\f]|\\[\s\S])+')/ig;
  callback = callback || function(m, $1, $2, $3, $4, $5, $6, $7, $8, $9, $10) {
    if ($1) { //<script>
      var embed = '';
      $1 = $1.replace(/(\s(?:data-)?src\s*=\s*)('[^']+'|"[^"]+"|[^\s\/>]+)/ig, function(m, prefix, value) {
        if (isInline(fis.util.query(value))) {
          // 如果是需要inline的，需要把src内指向的资源嵌到<script></script>内
          // 在这里先生成用来内嵌的中间码
          embed += map.embed.wrap(value);
          // 去掉[data-]src=*
          return '';
        } else {
          // '[data-]src=uri中间码'
          return prefix + map.uri.wrap(value);
        }
      });
      if (embed) {
        //embed file
        // '<script>用来内嵌的中间码'
        m = $1 + embed;
      } else {
        // 如果标签内有写MIME格式'type="text/javascript"'，则根据MIME格式来决定要将script标签认为是什么格式的文件
        // 主要任务是对$2代表的内嵌文本进行处理
        m = xLang($1, $2, file, rType.test($1) ? (RegExp.$3 === 'javascript' ? 'js' : 'html') : 'js');
      }
    } else if ($3) { //<style>
      m = xLang($3, $4, file, 'css');
    } else if ($5) { //<img|embed|audio|video|link|object|source>
      var tag = $5.toLowerCase();
      if (tag === 'link') {
        var inline = '',
          isCssLink = false,
          isImportLink = false;
        var result = m.match(/\srel\s*=\s*('[^']+'|"[^"]+"|[^\s\/>]+)/i);
        if (result && result[1]) {
          var rel = result[1].replace(/^['"]|['"]$/g, '').toLowerCase();
          isCssLink = rel === 'stylesheet';
          isImportLink = rel === 'import';
        }
        m = m.replace(/(\s(?:data-)?href\s*=\s*)('[^']+'|"[^"]+"|[^\s\/>]+)/ig, function(_, prefix, value) {
          if ((isCssLink || isImportLink) && isInline(fis.util.query(value))) {
            // 需要使将目标文件中的内容内嵌
            if (isCssLink) {
              // 内嵌的资源是css，需要以<style>开头
              // 将link的属性去除掉无关属性后复制到style上
              inline += '<style' + m.substring(5).replace(/\/(?=>$)/, '').replace(/\s+(?:charset|href|data-href|hreflang|rel|rev|sizes|target)\s*=\s*(?:'[^']+'|"[^"]+"|[^\s\/>]+)/ig, '');
            }

            // link的目标地址标记个embed的中间码
            // extra的值
            // '<link href="a/b.css" extra1="1" extra2="2">' -> 'extra1="1" extra2="2"'
            inline += map.embed.wrap(value, m.replace(/^<link\b|\/?>$|\b(?:rel|href)='[^']*'|\b(?:rel|href)="[^"]*"/g, '').trim());
            if (isCssLink) {
              // 内嵌的资源是css，需要以</style>结尾
              inline += '</style>';
            }
            return '';
          } else {
            // 不需要内嵌，只需要把地址转成对应文件产出的url
            return prefix + map.uri.wrap(value);
          }
        });
        m = inline || m;
      } else if (tag === 'object') {
        m = m.replace(/(\sdata\s*=\s*)('[^']+'|"[^"]+"|[^\s\/>]+)/ig, function(m, prefix, value) {
          return prefix + map.uri.wrap(value);
        });
      } else {
        // <img|embed|audio|video|source>
        m = m.replace(/(\s(?:(?:data-)?src(?:set)?|poster)\s*=\s*)('[^']+'|"[^"]+"|[^\s\/>]+)/ig, function(m, prefix, value) {
          // embed就是把引用以base64形式嵌入
          // uri就是翻译成产出的地址
          var key = isInline(fis.util.query(value)) ? 'embed' : 'uri';
          if (prefix.indexOf('srcset') != -1) {
            //support srcset
            // img的srcset中可以包含多个src
            var info = fis.util.stringQuote(value);
            var srcset = [];
            info.rest.split(',').forEach(function(item) {
              var p;
              item = item.trim();
              // srcset="/assets/img/x100.png, /assets/img/x200.png 2x, /assets/img/x300.png 3x"
              if ((p = item.indexOf(' ')) == -1) {
                // 没有空格说明item就是src
                srcset.push(item);
                return;
              }
              // 有空格，只对空格前的内容做wrap
              srcset.push(map['uri'].wrap(item.substr(0, p)) + item.substr(p));
            });
            return prefix + info.quote + srcset.join(', ') + info.quote;
          }
          return prefix + map[key].wrap(value);
        });
      }
    } else if ($6) {
      // 文本直接内嵌
      // <!--[文件位置]-->
      m = map.embed.wrap($6);
    } else if ($8) {
      // 解析注释中的dep和sourceMap信息
      m = '<!--' + analyseComment($8) + $9;
    } else if ($10) {
      // 处理内联样式
      // <div style="**">
      var quote = $10[0];
      m = 'style=' + quote + map.inlineStyle.wrap($10.substring(1, $10.length - 1)) + quote;
    }
    return m;
  };
  content = content.replace(reg, callback);

  var info = {
    file: file,
    content: content
  };

  fis.emit('standard:html', info);

  return info.content;
}

/**
 * 处理type类型为 `x-**` 的block标签。
 *
 * ```css
 * <head>
 *   <style type="x-scss">
 *    &commat;import "compass/css3";
 *
 *    #border-radius {
 *      &commat;include border-radius(25px);
 *    }
 *   </style>
 * </head>
 * ```
 * @param  {String} tag        标签
 * @param  {String} content    the content of file
 * @param  {File} file         fis.file instance
 * @param  {String} defaultExt what is ?
 * @return {String}
 * @function
 * @memberOf fis.compile
 */
function xLang(tag, content, file, defaultExt) {
  var ext = defaultExt;

  if (file.pipeEmbed === false) {
    // 将宿主file的pipeEmbed设为false，则只对content做简单的standardlize处理
    switch (ext) {
      case 'html':
        content = extHtml(content, null, file);
        break;

      case 'js':
        content = extJs(content, null, file);
        break;

      case 'css':
        content = extCss(content, null, file);
        break;
    }

    return tag + content;
  } else {
    // 把内嵌的文本作为一个file，打个需要pipe的中间码
    var isXLang = false;

    // 尝试解析tag上的type属性
    // type="text/*"
    // type="application/*"
    var m = rType.exec(tag);
    if (m) {
      // lang就是'/'后的'*'
      var lang = m[3].toLowerCase();

      // 尝试根据lang解析type
      switch (lang) {
        case 'javascript':
          ext = 'js';
          break;

        case 'css':
          ext = 'css';
          break;

        default:
          // 'x-'开头说明是特殊语言
          // 比如'x-less'
          if (lang.substring(0, 2) === 'x-') {
            // 'less'
            ext = lang.substring(2);
            isXLang = true;
          }
          break;
      }
    }

    if (isXLang) {
      // 当前的type浏览器是无法解析的，可能的话应将type值替换成产出物的值
      // 比如'less' -> 'text/css'
      var mime = _.getMimeType(ext);
      mime && (mime !== 'application/x-' + ext) && (tag = tag.replace(rType, function(all, quote) {
        return ' type=' + quote + mime + quote;
      }));
    }
  }

  return tag + map.xlang.wrap(content, ext);
}

/**
 * 单文件编译入口，与 {@link fis.compile} 不同的是，此方法内部不进行缓存判断。
 * @param  {File} file 文件对象
 * @memberOf fis.compile
 * @name process
 * @function
 */
function process(file, context) {
  fis.emit('process:start', file);
  pipe(file, 'parser');
  pipe(file, 'preprocessor');
  pipe(file, 'standard');
  postStandard(file, context);
  pipe(file, 'postprocessor');
  pipe(file, 'optimizer');
  fis.emit('process:end', file);
}

/**
 * 让文件像管道一样经过某个流程处理。注意，跟 stream 的 pipe 不同，此方法不支持异步，而是同步的处理。
 * @memberOf fis.compile
 * @inner
 * @name pipe
 * @function
 * @param {File} file 文件对象
 * @param {String} type 类型
 * @param {Boolean} [keep] 是否保留文件内容。
 */
function pipe(file, type, keep) {
  var processors = [];
  // type对应的值是processor
  var prop = file[type];

  if (type === 'standard' && 'undefined' === typeof prop) {
    // standard阶段，一般调用内部的processor
    processors.push('builtin');
  }

  if (prop) {
    var typeOf = typeof prop;
    if (typeOf === 'string') {
      prop = prop.trim().split(/\s*,\s*/);
    } else if (!Array.isArray(prop)) {
      prop = [prop];
    }

    processors = processors.concat(prop);
  }

  fis.emit('compile:' + type, file);

  if (processors.length) {

    // 过滤掉同名的插件, 没必要重复操作。
    processors = processors.filter(function(item, idx, arr) {
      item = item.__name || item;

      return idx === _.findIndex(arr, function(target) {
        target = target.__name || target;

        return target === item;
      });
    });

    var callback = function(processor, settings, key) {
      settings.filename = file.realpath;
      var content = file.getContent();
      try {
        fis.log.debug('pipe [' + key + '] start');
        var result = processor(content, file, settings);
        fis.log.debug('pipe [' + key + '] end');
        if (keep) {
          file.setContent(content);
        } else if (typeof result === 'undefined') {
          fis.log.warning('invalid content return of pipe [' + key + ']');
        } else {
          file.setContent(result);
        }
      } catch (e) {
        if (typeof e === 'string') {
          e = new Error(e);
        }

        //log error
        fis.log.debug('pipe [' + key + '] fail');
        var msg = key + ': ' + String(e.message || e.msg || e).trim() + ' [' + (e.filename || file.realpath);
        if (e.hasOwnProperty('line')) {
          msg += ':' + e.line;
          if (e.hasOwnProperty('col')) {
            msg += ':' + e.col;
          } else if (e.hasOwnProperty('column')) {
            msg += ':' + e.column;
          }
        }
        msg += ']';
        e.message = msg;
        error(e);
      }
    };

    processors.forEach(function(processor, index) {
      var typeOf = typeof processor,
        key, options;

      // 通过fis-plugin声明的
      if (typeOf === 'object' && processor.__name) {
        // processor本身就是配置
        options = processor;
        processor = processor.__name;
        typeOf = typeof processor;
      }

      // 直接用字符串声明的
      if (typeOf === 'string') {
        key = type + '.' + processor;
        // standard阶段，一般调用内部的processor
        processor = (type === 'standard' && processor === 'builtin') ? builtinStandard : fis.require(type, processor);
      } else {
        key = type + '.' + index;
      }

      if (typeof processor === 'function') {
        var settings = {};
        _.assign(settings, processor.defaultOptions || processor.options || {});
        _.assign(settings, fis.media().get('settings.' + key, {}));
        _.assign(settings, options || {});

        // 删除隐藏配置
        delete settings.__name;
        delete settings.__plugin;
        delete settings.__pos;
        delete settings.__isPlugin;

        callback(processor, settings, key);
      } else {
        fis.log.warning('invalid processor [modules.' + key + ']');
      }
    });
  }
}

var lockedMap = {};

/*
 * error收集&输出
 * @param  {String} msg 输出的
 */
function error(msg) {
  //for watching, unable to exit
  lockedMap = {};
  fis.log.error(msg);
}

/*
 * 检查依赖是否存在闭环
 * @param  {String} from
 * @param  {String} to
 * @return {Boolean}
 */
function lockedCheck(from, to) {
  from = fis.file.wrap(from).realpath;
  to = fis.file.wrap(to).realpath;
  if (from === to) {
    // 来源和目标的realPath相同
    return true;
  } else if (lockedMap[to]) {
    // 已有文件请求并正在编译to
    var prev = from;
    var msg = [];

    do {
      msg.unshift(prev);
      prev = lockedMap[prev];
    } while (prev);

    prev && msg.unshift(prev);
    msg.push(to);
    // prev0 prev1 prev2 from to
    return msg;
  }
  return false;
}

/*
 * 设置 lockedMap 的值，用来 check.
 */
function lock(from, to) {
  from = fis.file.wrap(from).realpath;
  to = fis.file.wrap(to).realpath;

  lockedMap[to] = from;
}

/*
 * 删除的对应的 lockedMap 的值
 * @param  {Object} file
 */
function unlock(to) {
  to = fis.file.wrap(to).realpath;
  delete lockedMap[to];
}

/*
 * 添加依赖
 * @param {Object} a
 * @param {Object} b
 */
function addDeps(a, b) {
  if (a && a.cache && b) {
    if (b.cache) {
      a.cache.mergeDeps(b.cache);
    }
    a.cache.addDeps(b.realpath || b);
  }
}

function addMissingDeps(file, value) {
  if (file && file.cache && value) {
    if (value[0] === '"' || value[0] === "'") {
      value = value.substring(1, value.length - 1);
    }

    var filepath = _.isAbsolute(value) ? value : path.join(file.dirname, value), value;

    file.cache.addMissingDeps(filepath, value);
  }
}

/**
 * 内置的标准化处理函数，外部可以覆写此过程。
 *
 * - 对 html 文件进行 {@link fis.compile.extHtml} 处理。
 * - 对 js 文件进行 {@link fis.compile.extjs} 处理。
 * - 对 css 文件进行 {@link fis.compile.extCss} 处理。
 *
 * @param  {String} content 文件内容
 * @param  {File} file    文件对象
 * @param  {Object} conf    标准化配置项
 * @memberOf fis.compile
 * @inner
 */
function builtinStandard(content, file, conf) {
  if (typeof content === 'string') {
    fis.log.debug('builtin standard for [%s] start', file.realpath);
    var type;
    if (conf.type && conf.type !== 'auto') {
      // type可以设成是file的rExt（release ext）去掉开头的'.'
      // 一般不推荐使用
      type = conf.type;
    } else {
      // 一般用这个来判断使用什么方法来standardlize
      type = file.isHtmlLike ? 'html' : (file.isJsLike ? 'js' : (file.isCssLike ? 'css' : ''));
    }

    // 主要目的是将各种指令翻译成中间码
    switch (type) {
      case 'html':
        content = extHtml(content, null, file);
        break;

      case 'js':
        content = extJs(content, null, file);
        break;

      case 'css':
        content = extCss(content, null, file);
        break;

      default:
        // unrecognized.
        break;
    }
    fis.log.debug('builtin standard for [%s] end', file.realpath);
  }
  return content;
}

/**
 * 将中间码还原成源码。
 *
 * 中间码说明：（待补充）
 *
 * @inner
 * @memberOf fis.compile
 * @param  {file} file 文件对象
 */
function postStandard(file, context) {
  fis.emit('standard:restore:start', file);
  var content = file.getContent();

  if (typeof content !== 'string') {
    return;
  }

  fis.log.debug('postStandard start');

  var reg = map.reg;
  // 因为处理过程中可能新生成中间码，所以要拉个判断。
  while (reg.test(content)) {
    reg.lastIndex = 0; // 重置 regexp
    content = content.replace(reg, function(all, type, depth, value, extra) {
      var ret = '',
        info, id;
      try {
        switch (type) {
          case 'id':
            info = fis.project.lookup(value, file);
            // 如果value是有quote的，那么id还是要用quote包裹
            ret = info.quote + info.id + info.quote;

            if (info.file && info.file.isFile()) {
              file.addLink(info.file.subpath);
            }
            break;
          case 'moduleId':
            info = fis.project.lookup(value, file);
            ret = info.quote + info.moduleId + info.quote;

            if (info.file && info.file.isFile()) {
              file.addLink(info.file.subpath);
            }
            break;
          case 'hash':
            info = fis.project.lookup(value, file);
            if (info.file && info.file.isFile()) {

              file.addLink(info.file.subpath);

              var locked = lockedCheck(file, info.file);
              if (!locked) {
                // locked为true就说明info.file已经在编译中，为防止死循环就不再编译
                // compileFrom: file
                // compileTo: info.file
                lock(file, info.file);
                // 确保info.file是编译后的
                exports(info.file, context);
                // 编译完成，释放
                unlock(info.file);
                // file依赖info.file的编译结果
                // 因为当info.file发生变化时，hash需要重新获取
                addDeps(file, info.file);
              }

              // 第一次获取hash后，file的hash不会再改变
              var md5 = info.file.getHash();
              ret = info.quote + md5 + info.quote;
            } else {
              ret = value;
              addMissingDeps(file, value);
            }
            break;
          case 'require':
          case 'jsRequire':
            info = fis.project.lookup(value, file);
            file.addRequire(info.id);

            if (type === 'jsRequire' && info.moduleId) {
              // js文件里的require优先使用moduleId
              ret = info.quote + info.moduleId + info.quote;
            } else {
              ret = info.quote + info.id + info.quote;
            }

            if (info.file && info.file.isFile()) {
              file.addLink(info.file.subpath);
            }
            break;

          case 'async':
          case 'jsAsync':
            info = fis.project.lookup(value, file);
            file.addAsyncRequire(info.id);

            if (type === 'jsAsync' && info.moduleId) {
              ret = info.quote + info.moduleId + info.quote;
            } else {
              ret = info.quote + info.id + info.quote;
            }

            if (info.file && info.file.isFile()) {
              file.addLink(info.file.subpath);
            }
            break;
          case 'uri':
            info = fis.project.lookup(value, file);
            if (info.file && info.file.isFile()) {

              file.addLink(info.file.subpath);

              if (info.file.useHash) {
                var locked = lockedCheck(file, info.file);
                if (!locked) {
                  lock(file, info.file);
                  exports(info.file, context);
                  unlock(info.file);
                  addDeps(file, info.file);
                }
              }
              // query如果不是空字符串必然是'?'开始
              var query = (info.file.query && info.query) ? '&' + info.query.substring(1) : info.query;
              var url = info.file.getUrl();
              // hash如果不是空字符串必然是'#'开始
              // 优先使用value的hash
              // value本身的字符串内包含hash
              // file通过match也能绑hash
              var hash = info.hash || info.file.hash;
              // '"a.com/b/c?123#456"'
              ret = info.quote + url + query + hash + info.quote;
            } else {
              ret = value;
              addMissingDeps(file, value);
            }
            break;
          case 'dep':
            if (file.cache) {
              info = fis.project.lookup(value, file);
              addDeps(file, info.file);
            } else {
              fis.log.warning('unable to add deps to file [' + path + ']');
              addMissingDeps(file, value);
            }
            break;
          case 'embed':
          case 'jsEmbed':
            info = fis.project.lookup(value, file);
            var f;
            if (info.file) {
              f = info.file;
            } else if (fis.util.isAbsolute(info.rest)) {
              // 直接用绝对地址查找文件
              f = fis.file(info.rest);
            }
            if (f && f.isFile()) {
              file.addLink(f.subpath);
              var locked = lockedCheck(file, info.file);
              if (!locked) {
                lock(file, f);
                f.isInline = true;
                exports(f, context);
                unlock(f);
                addDeps(file, f);
                copyInfo(f, file);

                if (f.isText()) {
                  ret = f.getContent();
                  if (type === 'jsEmbed' && !f.isJsLike && !f.isJsonLike) {
                    // f无法解析成js，也无法解析成json，只能将f的文本作为字符串内嵌到js内容中
                    ret = JSON.stringify(ret);
                  }

                  extra && (ret = filterEmbed(ret, extra));
                } else {
                  // f不是文本文件，用base64的字符串来作为它的内容
                  ret = info.quote + f.getBase64() + info.quote;
                }
              } else {
                var msg = 'unable to embed file[' + file.realpath + '] into itself.';

                if (locked.splice) {
                  msg = 'circular embed `' + locked.join('` -> `') + '`.';
                }

                error(msg);
              }
            } else {
              fis.log.error('unable to embed non-existent file %s', value);
            }
            break;
          case 'xlang':
            ret = partial(value, file, extra);
            break;

          case 'inlineStyle':
            // 包裹后才使得声明可以被fis作为css解析
            // inline-style-placeholder {color: red;}
            ret = partial('inline-style-placeholder {' + value + '}', file, {
              ext: 'css',
              xLang: ':inline-style'
            });
            ret = ret.replace(/inline-style-placeholder\s?\{([\s\S]*)\}/, '$1');
            break;

          case 'sourceMap':
            info = fis.project.lookup(value, file, true);
            if (info.file && info.file.isFile()) {

              file.addLink(info.file.subpath);

              if (info.file.useHash) {
                var locked = lockedCheck(file, info.file);
                if (!locked) {
                  lock(file, info.file);
                  exports(info.file, context);
                  unlock(info.file);
                  addDeps(file, info.file);
                }
              }
              var query = (info.file.query && info.query) ? '&' + info.query.substring(1) : info.query;
              var url = info.file.getUrl();
              var hash = info.hash || info.file.hash;
              ret = info.quote + url + query + hash + info.quote;

              file.extras = file.extras || {};
              file.extras.derived = file.extras.derived || [];
              file.extras.derived.push(info.file);
            } else {
              ret = value;
            }
            break;

            // 用来存信息的，内容会被移除。
          case 'info':
            ret = '';
            break;
          default:
            if (!map[type]) {
              fis.log.error('unsupported fis language tag [%s]', type);
            }
        }

        // trigger event.
        var message = {
          ret: ret,
          value: value,
          file: file,
          info: info,
          type: type
        };
        fis.emit('standard:restore', message);
        fis.emit('standard:restore:' + type, message);
        ret = message.ret;
      } catch (e) {
        lockedMap = {};
        e.message = e.message + ' in [' + file.subpath + ']';
        throw e;
      }
      return ret;
    });
  }
  file.setContent(content);
  fis.emit('standard:restore:end', file);
  fis.log.debug('postStandard end');
}

/**
 * 编译代码片段。用于在 html 中内嵌其他异构语言。
 * @param {String} content 代码片段。
 * @param {File} host 代码片段所在的文件，用于片段中对其他资源的查找。
 * @param {Object} info 文件信息。
 * @memberOf fis.compile
 * @example
 * var file = fis.file(root, 'static/_nav.tmpl');
 * var content = file.getContent();
 *
 * // tmpl 文件本身是 html 文件，但是会被解析成 js 文件供 js 使用。正常情况下他只有 js 语言能力。但是：
 * content = fis.compile.partial(content, file, {
 *    ext: 'html' // set isHtmlLike
 * });
 *
 * file.setConent(content);
 *
 * // 继续走之后的 js parser 流程。
 */
function partial(content, host, info) {

  // 默认 html 内嵌的 js, css 内容，都会独立走一遍单文件编译流程。
  // 可以通过 pipeEmbed 属性设置成 `false` 来关闭。
  if (host.pipeEmbed === false) {
    return content;
  }

  if (content.trim()) {
    info = typeof info === 'string' ? {
      ext: info
    } : (info || {});
    var ext = info.ext || host.ext;
    ext[0] === '.' && (ext = ext.substring(1));
    info.ext = '.' + ext;
    // xLang使得可以用match对文件中内嵌的特殊语言脚本做配置
    // xLang可以避免新创建的file的match cache与宿主file的match cache冲突
    info.xLang = info.xLang || (':' + ext);

    // 文件还是用代码所在文件作为内容载体
    var f = fis.file(host.realpath, info);
    f.cache = host.cache;
    f.isPartial = true;
    f.isInline = true;
    // 内容设置为代码
    f.setContent(content);
    // f本身并不是真正的文件不使用物理cache，直接process
    process(f);
    // f的相关依赖转移给代码所在文件
    copyInfo(f, host);
    // 返回process后的内容
    content = f.getContent();
  }

  return content;
}

// todo 支持外部扩展，支持更多的语法。
function filterEmbed(ret, attrs) {
  var params = {};
  attrs.split(/\s+/).forEach(function(param) {
    var parts = param.split('=');
    params[parts[0]] = parts[1].substring(1, parts[1].length - 1);
  });

  return ret.replace(/<!-- @@((?:\n?.)*?)-->/g, function(_, operator) {
    var parts = operator.split(/\s+/);

    if (parts[0] === 'var') {
      return params[parts[1]] || '';
    }

    return _;
  });
}

function copyInfo(src, dst) {
  var addFn = {
    'requires': 'addRequire',
    'asyncs': 'addAsyncRequire',
    'links': 'addLink'
  };

  Object.keys(addFn).forEach(function(key) {
    src[key].forEach(function(item) {
      dst[addFn[key]](item);
    });
  });
}

function resourceMapFile(file) {
  var content = file.getContent();
  var reg = /\b__RESOURCE_MAP__\b/g;
  // 如果写文档时包含了此字符，不应该替换，所以强制判断一下
  if (content.match(reg) && typeof file._isResourceMap == 'undefined') {
    file._isResourceMap = true; // special file
    file.useCache = false; // disable cache
    return true;
  }
  return false;
}

/*
 * adjust file
 * @param file
 */
function adjust(file) {
  if (file.isText()) {
    resourceMapFile(file);
  }
}

exports.process = process;
exports.extJs = extJs;
exports.extCss = extCss;
exports.extHtml = extHtml;
exports.xLang = xLang;
exports.partial = partial;
exports.isInline = isInline;
exports.analyseComment = analyseComment;
