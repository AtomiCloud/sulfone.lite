// @bun
// node_modules/.bun/eta@3.5.0/node_modules/eta/dist/eta.module.mjs
import * as path from 'path';
import * as fs from 'fs';

class Cacher {
  constructor(cache) {
    this.cache = undefined;
    this.cache = cache;
  }
  define(key, val) {
    this.cache[key] = val;
  }
  get(key) {
    return this.cache[key];
  }
  remove(key) {
    delete this.cache[key];
  }
  reset() {
    this.cache = {};
  }
  load(cacheObj) {
    this.cache = {
      ...this.cache,
      ...cacheObj,
    };
  }
}

class EtaError extends Error {
  constructor(message) {
    super(message);
    this.name = 'Eta Error';
  }
}

class EtaParseError extends EtaError {
  constructor(message) {
    super(message);
    this.name = 'EtaParser Error';
  }
}

class EtaRuntimeError extends EtaError {
  constructor(message) {
    super(message);
    this.name = 'EtaRuntime Error';
  }
}

class EtaFileResolutionError extends EtaError {
  constructor(message) {
    super(message);
    this.name = 'EtaFileResolution Error';
  }
}

class EtaNameResolutionError extends EtaError {
  constructor(message) {
    super(message);
    this.name = 'EtaNameResolution Error';
  }
}
function ParseErr(message, str, indx) {
  const whitespace = str.slice(0, indx).split(/\n/);
  const lineNo = whitespace.length;
  const colNo = whitespace[lineNo - 1].length + 1;
  message +=
    ' at line ' +
    lineNo +
    ' col ' +
    colNo +
    `:

` +
    '  ' +
    str.split(/\n/)[lineNo - 1] +
    `
` +
    '  ' +
    Array(colNo).join(' ') +
    '^';
  throw new EtaParseError(message);
}
function RuntimeErr(originalError, str, lineNo, path2) {
  const lines = str.split(`
`);
  const start = Math.max(lineNo - 3, 0);
  const end = Math.min(lines.length, lineNo + 3);
  const filename = path2;
  const context = lines.slice(start, end).map(function (line, i) {
    const curr = i + start + 1;
    return (curr == lineNo ? ' >> ' : '    ') + curr + '| ' + line;
  }).join(`
`);
  const header = filename
    ? filename +
      ':' +
      lineNo +
      `
`
    : 'line ' +
      lineNo +
      `
`;
  const err = new EtaRuntimeError(
    header +
      context +
      `

` +
      originalError.message,
  );
  err.name = originalError.name;
  throw err;
}
var AsyncFunction = async function () {}.constructor;
function compile(str, options) {
  const config = this.config;
  const ctor = options && options.async ? AsyncFunction : Function;
  try {
    return new ctor(config.varName, 'options', this.compileToString.call(this, str, options));
  } catch (e) {
    if (e instanceof SyntaxError) {
      throw new EtaParseError(
        `Bad template syntax

` +
          e.message +
          `
` +
          Array(e.message.length + 1).join('=') +
          `
` +
          this.compileToString.call(this, str, options) +
          `
`,
      );
    } else {
      throw e;
    }
  }
}
function compileToString(str, options) {
  const config = this.config;
  const isAsync = options && options.async;
  const compileBody = this.compileBody;
  const buffer = this.parse.call(this, str);
  let res = `${config.functionHeader}
let include = (template, data) => this.render(template, data, options);
let includeAsync = (template, data) => this.renderAsync(template, data, options);

let __eta = {res: "", e: this.config.escapeFunction, f: this.config.filterFunction${config.debug ? ', line: 1, templateStr: "' + str.replace(/\\|"/g, '\\$&').replace(/\r\n|\n|\r/g, '\\n') + '"' : ''}};

function layout(path, data) {
  __eta.layout = path;
  __eta.layoutData = data;
}${config.debug ? 'try {' : ''}${config.useWith ? 'with(' + config.varName + '||{}){' : ''}

${compileBody.call(this, buffer)}
if (__eta.layout) {
  __eta.res = ${isAsync ? 'await includeAsync' : 'include'} (__eta.layout, {...${config.varName}, body: __eta.res, ...__eta.layoutData});
}
${config.useWith ? '}' : ''}${config.debug ? '} catch (e) { this.RuntimeErr(e, __eta.templateStr, __eta.line, options.filepath) }' : ''}
return __eta.res;
`;
  if (config.plugins) {
    for (let i = 0; i < config.plugins.length; i++) {
      const plugin = config.plugins[i];
      if (plugin.processFnString) {
        res = plugin.processFnString(res, config);
      }
    }
  }
  return res;
}
function compileBody(buff) {
  const config = this.config;
  let i = 0;
  const buffLength = buff.length;
  let returnStr = '';
  for (i; i < buffLength; i++) {
    const currentBlock = buff[i];
    if (typeof currentBlock === 'string') {
      const str = currentBlock;
      returnStr +=
        "__eta.res+='" +
        str +
        `'
`;
    } else {
      const type = currentBlock.t;
      let content = currentBlock.val || '';
      if (config.debug)
        returnStr +=
          '__eta.line=' +
          currentBlock.lineNo +
          `
`;
      if (type === 'r') {
        if (config.autoFilter) {
          content = '__eta.f(' + content + ')';
        }
        returnStr +=
          '__eta.res+=' +
          content +
          `
`;
      } else if (type === 'i') {
        if (config.autoFilter) {
          content = '__eta.f(' + content + ')';
        }
        if (config.autoEscape) {
          content = '__eta.e(' + content + ')';
        }
        returnStr +=
          '__eta.res+=' +
          content +
          `
`;
      } else if (type === 'e') {
        returnStr +=
          content +
          `
`;
      }
    }
  }
  return returnStr;
}
function trimWS(str, config, wsLeft, wsRight) {
  let leftTrim;
  let rightTrim;
  if (Array.isArray(config.autoTrim)) {
    leftTrim = config.autoTrim[1];
    rightTrim = config.autoTrim[0];
  } else {
    leftTrim = rightTrim = config.autoTrim;
  }
  if (wsLeft || wsLeft === false) {
    leftTrim = wsLeft;
  }
  if (wsRight || wsRight === false) {
    rightTrim = wsRight;
  }
  if (!rightTrim && !leftTrim) {
    return str;
  }
  if (leftTrim === 'slurp' && rightTrim === 'slurp') {
    return str.trim();
  }
  if (leftTrim === '_' || leftTrim === 'slurp') {
    str = str.trimStart();
  } else if (leftTrim === '-' || leftTrim === 'nl') {
    str = str.replace(/^(?:\r\n|\n|\r)/, '');
  }
  if (rightTrim === '_' || rightTrim === 'slurp') {
    str = str.trimEnd();
  } else if (rightTrim === '-' || rightTrim === 'nl') {
    str = str.replace(/(?:\r\n|\n|\r)$/, '');
  }
  return str;
}
var escMap = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};
function replaceChar(s) {
  return escMap[s];
}
function XMLEscape(str) {
  const newStr = String(str);
  if (/[&<>"']/.test(newStr)) {
    return newStr.replace(/[&<>"']/g, replaceChar);
  } else {
    return newStr;
  }
}
var defaultConfig = {
  autoEscape: true,
  autoFilter: false,
  autoTrim: [false, 'nl'],
  cache: false,
  cacheFilepaths: true,
  debug: false,
  escapeFunction: XMLEscape,
  filterFunction: val => String(val),
  functionHeader: '',
  parse: {
    exec: '',
    interpolate: '=',
    raw: '~',
  },
  plugins: [],
  rmWhitespace: false,
  tags: ['<%', '%>'],
  useWith: false,
  varName: 'it',
  defaultExtension: '.eta',
};
var templateLitReg = /`(?:\\[\s\S]|\${(?:[^{}]|{(?:[^{}]|{[^}]*})*})*}|(?!\${)[^\\`])*`/g;
var singleQuoteReg = /'(?:\\[\s\w"'\\`]|[^\n\r'\\])*?'/g;
var doubleQuoteReg = /"(?:\\[\s\w"'\\`]|[^\n\r"\\])*?"/g;
function escapeRegExp(string) {
  return string.replace(/[.*+\-?^${}()|[\]\\]/g, '\\$&');
}
function getLineNo(str, index) {
  return str.slice(0, index).split(`
`).length;
}
function parse(str) {
  const config = this.config;
  let buffer = [];
  let trimLeftOfNextStr = false;
  let lastIndex = 0;
  const parseOptions = config.parse;
  if (config.plugins) {
    for (let i = 0; i < config.plugins.length; i++) {
      const plugin = config.plugins[i];
      if (plugin.processTemplate) {
        str = plugin.processTemplate(str, config);
      }
    }
  }
  if (config.rmWhitespace) {
    str = str
      .replace(
        /[\r\n]+/g,
        `
`,
      )
      .replace(/^\s+|\s+$/gm, '');
  }
  templateLitReg.lastIndex = 0;
  singleQuoteReg.lastIndex = 0;
  doubleQuoteReg.lastIndex = 0;
  function pushString(strng, shouldTrimRightOfString) {
    if (strng) {
      strng = trimWS(strng, config, trimLeftOfNextStr, shouldTrimRightOfString);
      if (strng) {
        strng = strng.replace(/\\|'/g, '\\$&').replace(/\r\n|\n|\r/g, '\\n');
        buffer.push(strng);
      }
    }
  }
  const prefixes = [parseOptions.exec, parseOptions.interpolate, parseOptions.raw].reduce(function (
    accumulator,
    prefix,
  ) {
    if (accumulator && prefix) {
      return accumulator + '|' + escapeRegExp(prefix);
    } else if (prefix) {
      return escapeRegExp(prefix);
    } else {
      return accumulator;
    }
  }, '');
  const parseOpenReg = new RegExp(escapeRegExp(config.tags[0]) + '(-|_)?\\s*(' + prefixes + ')?\\s*', 'g');
  const parseCloseReg = new RegExp('\'|"|`|\\/\\*|(\\s*(-|_)?' + escapeRegExp(config.tags[1]) + ')', 'g');
  let m;
  while ((m = parseOpenReg.exec(str))) {
    const precedingString = str.slice(lastIndex, m.index);
    lastIndex = m[0].length + m.index;
    const wsLeft = m[1];
    const prefix = m[2] || '';
    pushString(precedingString, wsLeft);
    parseCloseReg.lastIndex = lastIndex;
    let closeTag;
    let currentObj = false;
    while ((closeTag = parseCloseReg.exec(str))) {
      if (closeTag[1]) {
        const content = str.slice(lastIndex, closeTag.index);
        parseOpenReg.lastIndex = lastIndex = parseCloseReg.lastIndex;
        trimLeftOfNextStr = closeTag[2];
        const currentType =
          prefix === parseOptions.exec
            ? 'e'
            : prefix === parseOptions.raw
              ? 'r'
              : prefix === parseOptions.interpolate
                ? 'i'
                : '';
        currentObj = {
          t: currentType,
          val: content,
        };
        break;
      } else {
        const char = closeTag[0];
        if (char === '/*') {
          const commentCloseInd = str.indexOf('*/', parseCloseReg.lastIndex);
          if (commentCloseInd === -1) {
            ParseErr('unclosed comment', str, closeTag.index);
          }
          parseCloseReg.lastIndex = commentCloseInd;
        } else if (char === "'") {
          singleQuoteReg.lastIndex = closeTag.index;
          const singleQuoteMatch = singleQuoteReg.exec(str);
          if (singleQuoteMatch) {
            parseCloseReg.lastIndex = singleQuoteReg.lastIndex;
          } else {
            ParseErr('unclosed string', str, closeTag.index);
          }
        } else if (char === '"') {
          doubleQuoteReg.lastIndex = closeTag.index;
          const doubleQuoteMatch = doubleQuoteReg.exec(str);
          if (doubleQuoteMatch) {
            parseCloseReg.lastIndex = doubleQuoteReg.lastIndex;
          } else {
            ParseErr('unclosed string', str, closeTag.index);
          }
        } else if (char === '`') {
          templateLitReg.lastIndex = closeTag.index;
          const templateLitMatch = templateLitReg.exec(str);
          if (templateLitMatch) {
            parseCloseReg.lastIndex = templateLitReg.lastIndex;
          } else {
            ParseErr('unclosed string', str, closeTag.index);
          }
        }
      }
    }
    if (currentObj) {
      if (config.debug) {
        currentObj.lineNo = getLineNo(str, m.index);
      }
      buffer.push(currentObj);
    } else {
      ParseErr('unclosed tag', str, m.index);
    }
  }
  pushString(str.slice(lastIndex, str.length), false);
  if (config.plugins) {
    for (let i = 0; i < config.plugins.length; i++) {
      const plugin = config.plugins[i];
      if (plugin.processAST) {
        buffer = plugin.processAST(buffer, config);
      }
    }
  }
  return buffer;
}
function handleCache(template, options) {
  const templateStore = options && options.async ? this.templatesAsync : this.templatesSync;
  if (this.resolvePath && this.readFile && !template.startsWith('@')) {
    const templatePath = options.filepath;
    const cachedTemplate = templateStore.get(templatePath);
    if (this.config.cache && cachedTemplate) {
      return cachedTemplate;
    } else {
      const templateString = this.readFile(templatePath);
      const templateFn = this.compile(templateString, options);
      if (this.config.cache) templateStore.define(templatePath, templateFn);
      return templateFn;
    }
  } else {
    const cachedTemplate = templateStore.get(template);
    if (cachedTemplate) {
      return cachedTemplate;
    } else {
      throw new EtaNameResolutionError("Failed to get template '" + template + "'");
    }
  }
}
function render(template, data, meta) {
  let templateFn;
  const options = {
    ...meta,
    async: false,
  };
  if (typeof template === 'string') {
    if (this.resolvePath && this.readFile && !template.startsWith('@')) {
      options.filepath = this.resolvePath(template, options);
    }
    templateFn = handleCache.call(this, template, options);
  } else {
    templateFn = template;
  }
  const res = templateFn.call(this, data, options);
  return res;
}
function renderAsync(template, data, meta) {
  let templateFn;
  const options = {
    ...meta,
    async: true,
  };
  if (typeof template === 'string') {
    if (this.resolvePath && this.readFile && !template.startsWith('@')) {
      options.filepath = this.resolvePath(template, options);
    }
    templateFn = handleCache.call(this, template, options);
  } else {
    templateFn = template;
  }
  const res = templateFn.call(this, data, options);
  return Promise.resolve(res);
}
function renderString(template, data) {
  const templateFn = this.compile(template, {
    async: false,
  });
  return render.call(this, templateFn, data);
}
function renderStringAsync(template, data) {
  const templateFn = this.compile(template, {
    async: true,
  });
  return renderAsync.call(this, templateFn, data);
}

class Eta$1 {
  constructor(customConfig) {
    this.config = undefined;
    this.RuntimeErr = RuntimeErr;
    this.compile = compile;
    this.compileToString = compileToString;
    this.compileBody = compileBody;
    this.parse = parse;
    this.render = render;
    this.renderAsync = renderAsync;
    this.renderString = renderString;
    this.renderStringAsync = renderStringAsync;
    this.filepathCache = {};
    this.templatesSync = new Cacher({});
    this.templatesAsync = new Cacher({});
    this.resolvePath = null;
    this.readFile = null;
    if (customConfig) {
      this.config = {
        ...defaultConfig,
        ...customConfig,
      };
    } else {
      this.config = {
        ...defaultConfig,
      };
    }
  }
  configure(customConfig) {
    this.config = {
      ...this.config,
      ...customConfig,
    };
  }
  withConfig(customConfig) {
    return {
      ...this,
      config: {
        ...this.config,
        ...customConfig,
      },
    };
  }
  loadTemplate(name, template, options) {
    if (typeof template === 'string') {
      const templates = options && options.async ? this.templatesAsync : this.templatesSync;
      templates.define(name, this.compile(template, options));
    } else {
      let templates = this.templatesSync;
      if (template.constructor.name === 'AsyncFunction' || (options && options.async)) {
        templates = this.templatesAsync;
      }
      templates.define(name, template);
    }
  }
}
function readFile(path2) {
  let res = '';
  try {
    res = fs.readFileSync(path2, 'utf8');
  } catch (err) {
    if ((err == null ? undefined : err.code) === 'ENOENT') {
      throw new EtaFileResolutionError(`Could not find template: ${path2}`);
    } else {
      throw err;
    }
  }
  return res;
}
function resolvePath(templatePath, options) {
  let resolvedFilePath = '';
  const views = this.config.views;
  if (!views) {
    throw new EtaFileResolutionError('Views directory is not defined');
  }
  const baseFilePath = options && options.filepath;
  const defaultExtension = this.config.defaultExtension === undefined ? '.eta' : this.config.defaultExtension;
  const cacheIndex = JSON.stringify({
    filename: baseFilePath,
    path: templatePath,
    views: this.config.views,
  });
  templatePath += path.extname(templatePath) ? '' : defaultExtension;
  if (baseFilePath) {
    if (this.config.cacheFilepaths && this.filepathCache[cacheIndex]) {
      return this.filepathCache[cacheIndex];
    }
    const absolutePathTest = absolutePathRegExp.exec(templatePath);
    if (absolutePathTest && absolutePathTest.length) {
      const formattedPath = templatePath.replace(/^\/*|^\\*/, '');
      resolvedFilePath = path.join(views, formattedPath);
    } else {
      resolvedFilePath = path.join(path.dirname(baseFilePath), templatePath);
    }
  } else {
    resolvedFilePath = path.join(views, templatePath);
  }
  if (dirIsChild(views, resolvedFilePath)) {
    if (baseFilePath && this.config.cacheFilepaths) {
      this.filepathCache[cacheIndex] = resolvedFilePath;
    }
    return resolvedFilePath;
  } else {
    throw new EtaFileResolutionError(`Template '${templatePath}' is not in the views directory`);
  }
}
function dirIsChild(parent, dir) {
  const relative2 = path.relative(parent, dir);
  return relative2 && !relative2.startsWith('..') && !path.isAbsolute(relative2);
}
var absolutePathRegExp = /^\\|^\//;

class Eta extends Eta$1 {
  constructor(...args) {
    super(...args);
    this.readFile = readFile;
    this.resolvePath = resolvePath;
  }
}

// examples/artifacts/processor-default/src/index.ts
function processor(input) {
  const { files, config } = input;
  const processorConfig = readConfig(config);
  return Object.fromEntries(
    Object.entries(files).map(([path2, content]) => [
      renderTemplate(path2, processorConfig),
      normalizeTrailingWhitespace(renderTemplate(content, processorConfig)),
    ]),
  );
}
var defaultVarSyntax = [
  ['var__', '__'],
  ['__', '__'],
];
function readConfig(config) {
  if (!isRecord(config)) {
    return { vars: {}, varSyntax: defaultVarSyntax };
  }
  const vars = isRecord(config.vars) ? config.vars : {};
  const parser = isRecord(config.parser) ? config.parser : {};
  const configuredSyntax = Array.isArray(parser.varSyntax) ? parser.varSyntax.filter(isStringPair) : undefined;
  return { vars, varSyntax: configuredSyntax && configuredSyntax.length > 0 ? configuredSyntax : defaultVarSyntax };
}
function renderTemplate(content, config) {
  let rendered = content;
  for (const tags of config.varSyntax) {
    const masked = maskUnknownSimplePlaceholders(rendered, config.vars, tags);
    rendered = new Eta({
      autoEscape: false,
      autoTrim: [false, false],
      parse: { exec: '=', interpolate: '', raw: '~' },
      tags,
      useWith: true,
    }).renderString(masked.content, config.vars);
    rendered = restoreMaskedPlaceholders(rendered, masked.placeholders);
  }
  return rendered;
}
function maskUnknownSimplePlaceholders(content, vars, tags) {
  const placeholders = [];
  const [open, close] = tags.map(escapeRegExp2);
  const padded = tags[0] === '__' && tags[1] === '__' ? '' : '\\s*';
  const pattern = new RegExp(`${open}${padded}([A-Za-z_$][\\w$]*)${padded}${close}`, 'g');
  return {
    content: content.replace(pattern, (match, name) => {
      if (name in vars) {
        return match;
      }
      const index = placeholders.push(match) - 1;
      return `@@CYANPRINT_MASK_${index}@@`;
    }),
    placeholders,
  };
}
function restoreMaskedPlaceholders(content, placeholders) {
  return placeholders.reduce(
    (result, placeholder, index) => result.replaceAll(`@@CYANPRINT_MASK_${index}@@`, placeholder),
    content,
  );
}
function escapeRegExp2(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
function normalizeTrailingWhitespace(content) {
  return content
    .replace(
      /\r\n/g,
      `
`,
    )
    .replace(/[ \t]+$/gm, '')
    .replace(
      /\n*$/,
      `
`,
    );
}
function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function isStringPair(value) {
  return Array.isArray(value) && value.length === 2 && typeof value[0] === 'string' && typeof value[1] === 'string';
}
export { processor };
