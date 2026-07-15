// PLAN-36 Phase 1: standalone circles mailbox host, bundled for deploy.
// Built from scripts/mailbox-host.ts — do not edit; rebuild with deploy/mailbox-host/build.sh.
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __commonJS = (cb, mod) =>
  function __require() {
    return (
      mod || (0, cb[__getOwnPropNames(cb)[0]])((mod = { exports: {} }).exports, mod), mod.exports
    );
  };
var __copyProps = (to, from, except, desc) => {
  if ((from && typeof from === "object") || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, {
          get: () => from[key],
          enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable,
        });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (
  (target = mod != null ? __create(__getProtoOf(mod)) : {}),
  __copyProps(
    // If the importer is in node compatibility mode or this is not an ESM
    // file that has been converted to a CommonJS file using a Babel-
    // compatible transform (i.e. "__esModule" has not been set), then set
    // "default" to the CommonJS "module.exports" for node compatibility.
    isNodeMode || !mod || !mod.__esModule
      ? __defProp(target, "default", { value: mod, enumerable: true })
      : target,
    mod,
  )
);

// node_modules/.pnpm/json5@2.2.3/node_modules/json5/lib/unicode.js
var require_unicode = __commonJS({
  "node_modules/.pnpm/json5@2.2.3/node_modules/json5/lib/unicode.js"(exports, module) {
    module.exports.Space_Separator = /[\u1680\u2000-\u200A\u202F\u205F\u3000]/;
    module.exports.ID_Start =
      /[\xAA\xB5\xBA\xC0-\xD6\xD8-\xF6\xF8-\u02C1\u02C6-\u02D1\u02E0-\u02E4\u02EC\u02EE\u0370-\u0374\u0376\u0377\u037A-\u037D\u037F\u0386\u0388-\u038A\u038C\u038E-\u03A1\u03A3-\u03F5\u03F7-\u0481\u048A-\u052F\u0531-\u0556\u0559\u0561-\u0587\u05D0-\u05EA\u05F0-\u05F2\u0620-\u064A\u066E\u066F\u0671-\u06D3\u06D5\u06E5\u06E6\u06EE\u06EF\u06FA-\u06FC\u06FF\u0710\u0712-\u072F\u074D-\u07A5\u07B1\u07CA-\u07EA\u07F4\u07F5\u07FA\u0800-\u0815\u081A\u0824\u0828\u0840-\u0858\u0860-\u086A\u08A0-\u08B4\u08B6-\u08BD\u0904-\u0939\u093D\u0950\u0958-\u0961\u0971-\u0980\u0985-\u098C\u098F\u0990\u0993-\u09A8\u09AA-\u09B0\u09B2\u09B6-\u09B9\u09BD\u09CE\u09DC\u09DD\u09DF-\u09E1\u09F0\u09F1\u09FC\u0A05-\u0A0A\u0A0F\u0A10\u0A13-\u0A28\u0A2A-\u0A30\u0A32\u0A33\u0A35\u0A36\u0A38\u0A39\u0A59-\u0A5C\u0A5E\u0A72-\u0A74\u0A85-\u0A8D\u0A8F-\u0A91\u0A93-\u0AA8\u0AAA-\u0AB0\u0AB2\u0AB3\u0AB5-\u0AB9\u0ABD\u0AD0\u0AE0\u0AE1\u0AF9\u0B05-\u0B0C\u0B0F\u0B10\u0B13-\u0B28\u0B2A-\u0B30\u0B32\u0B33\u0B35-\u0B39\u0B3D\u0B5C\u0B5D\u0B5F-\u0B61\u0B71\u0B83\u0B85-\u0B8A\u0B8E-\u0B90\u0B92-\u0B95\u0B99\u0B9A\u0B9C\u0B9E\u0B9F\u0BA3\u0BA4\u0BA8-\u0BAA\u0BAE-\u0BB9\u0BD0\u0C05-\u0C0C\u0C0E-\u0C10\u0C12-\u0C28\u0C2A-\u0C39\u0C3D\u0C58-\u0C5A\u0C60\u0C61\u0C80\u0C85-\u0C8C\u0C8E-\u0C90\u0C92-\u0CA8\u0CAA-\u0CB3\u0CB5-\u0CB9\u0CBD\u0CDE\u0CE0\u0CE1\u0CF1\u0CF2\u0D05-\u0D0C\u0D0E-\u0D10\u0D12-\u0D3A\u0D3D\u0D4E\u0D54-\u0D56\u0D5F-\u0D61\u0D7A-\u0D7F\u0D85-\u0D96\u0D9A-\u0DB1\u0DB3-\u0DBB\u0DBD\u0DC0-\u0DC6\u0E01-\u0E30\u0E32\u0E33\u0E40-\u0E46\u0E81\u0E82\u0E84\u0E87\u0E88\u0E8A\u0E8D\u0E94-\u0E97\u0E99-\u0E9F\u0EA1-\u0EA3\u0EA5\u0EA7\u0EAA\u0EAB\u0EAD-\u0EB0\u0EB2\u0EB3\u0EBD\u0EC0-\u0EC4\u0EC6\u0EDC-\u0EDF\u0F00\u0F40-\u0F47\u0F49-\u0F6C\u0F88-\u0F8C\u1000-\u102A\u103F\u1050-\u1055\u105A-\u105D\u1061\u1065\u1066\u106E-\u1070\u1075-\u1081\u108E\u10A0-\u10C5\u10C7\u10CD\u10D0-\u10FA\u10FC-\u1248\u124A-\u124D\u1250-\u1256\u1258\u125A-\u125D\u1260-\u1288\u128A-\u128D\u1290-\u12B0\u12B2-\u12B5\u12B8-\u12BE\u12C0\u12C2-\u12C5\u12C8-\u12D6\u12D8-\u1310\u1312-\u1315\u1318-\u135A\u1380-\u138F\u13A0-\u13F5\u13F8-\u13FD\u1401-\u166C\u166F-\u167F\u1681-\u169A\u16A0-\u16EA\u16EE-\u16F8\u1700-\u170C\u170E-\u1711\u1720-\u1731\u1740-\u1751\u1760-\u176C\u176E-\u1770\u1780-\u17B3\u17D7\u17DC\u1820-\u1877\u1880-\u1884\u1887-\u18A8\u18AA\u18B0-\u18F5\u1900-\u191E\u1950-\u196D\u1970-\u1974\u1980-\u19AB\u19B0-\u19C9\u1A00-\u1A16\u1A20-\u1A54\u1AA7\u1B05-\u1B33\u1B45-\u1B4B\u1B83-\u1BA0\u1BAE\u1BAF\u1BBA-\u1BE5\u1C00-\u1C23\u1C4D-\u1C4F\u1C5A-\u1C7D\u1C80-\u1C88\u1CE9-\u1CEC\u1CEE-\u1CF1\u1CF5\u1CF6\u1D00-\u1DBF\u1E00-\u1F15\u1F18-\u1F1D\u1F20-\u1F45\u1F48-\u1F4D\u1F50-\u1F57\u1F59\u1F5B\u1F5D\u1F5F-\u1F7D\u1F80-\u1FB4\u1FB6-\u1FBC\u1FBE\u1FC2-\u1FC4\u1FC6-\u1FCC\u1FD0-\u1FD3\u1FD6-\u1FDB\u1FE0-\u1FEC\u1FF2-\u1FF4\u1FF6-\u1FFC\u2071\u207F\u2090-\u209C\u2102\u2107\u210A-\u2113\u2115\u2119-\u211D\u2124\u2126\u2128\u212A-\u212D\u212F-\u2139\u213C-\u213F\u2145-\u2149\u214E\u2160-\u2188\u2C00-\u2C2E\u2C30-\u2C5E\u2C60-\u2CE4\u2CEB-\u2CEE\u2CF2\u2CF3\u2D00-\u2D25\u2D27\u2D2D\u2D30-\u2D67\u2D6F\u2D80-\u2D96\u2DA0-\u2DA6\u2DA8-\u2DAE\u2DB0-\u2DB6\u2DB8-\u2DBE\u2DC0-\u2DC6\u2DC8-\u2DCE\u2DD0-\u2DD6\u2DD8-\u2DDE\u2E2F\u3005-\u3007\u3021-\u3029\u3031-\u3035\u3038-\u303C\u3041-\u3096\u309D-\u309F\u30A1-\u30FA\u30FC-\u30FF\u3105-\u312E\u3131-\u318E\u31A0-\u31BA\u31F0-\u31FF\u3400-\u4DB5\u4E00-\u9FEA\uA000-\uA48C\uA4D0-\uA4FD\uA500-\uA60C\uA610-\uA61F\uA62A\uA62B\uA640-\uA66E\uA67F-\uA69D\uA6A0-\uA6EF\uA717-\uA71F\uA722-\uA788\uA78B-\uA7AE\uA7B0-\uA7B7\uA7F7-\uA801\uA803-\uA805\uA807-\uA80A\uA80C-\uA822\uA840-\uA873\uA882-\uA8B3\uA8F2-\uA8F7\uA8FB\uA8FD\uA90A-\uA925\uA930-\uA946\uA960-\uA97C\uA984-\uA9B2\uA9CF\uA9E0-\uA9E4\uA9E6-\uA9EF\uA9FA-\uA9FE\uAA00-\uAA28\uAA40-\uAA42\uAA44-\uAA4B\uAA60-\uAA76\uAA7A\uAA7E-\uAAAF\uAAB1\uAAB5\uAAB6\uAAB9-\uAABD\uAAC0\uAAC2\uAADB-\uAADD\uAAE0-\uAAEA\uAAF2-\uAAF4\uAB01-\uAB06\uAB09-\uAB0E\uAB11-\uAB16\uAB20-\uAB26\uAB28-\uAB2E\uAB30-\uAB5A\uAB5C-\uAB65\uAB70-\uABE2\uAC00-\uD7A3\uD7B0-\uD7C6\uD7CB-\uD7FB\uF900-\uFA6D\uFA70-\uFAD9\uFB00-\uFB06\uFB13-\uFB17\uFB1D\uFB1F-\uFB28\uFB2A-\uFB36\uFB38-\uFB3C\uFB3E\uFB40\uFB41\uFB43\uFB44\uFB46-\uFBB1\uFBD3-\uFD3D\uFD50-\uFD8F\uFD92-\uFDC7\uFDF0-\uFDFB\uFE70-\uFE74\uFE76-\uFEFC\uFF21-\uFF3A\uFF41-\uFF5A\uFF66-\uFFBE\uFFC2-\uFFC7\uFFCA-\uFFCF\uFFD2-\uFFD7\uFFDA-\uFFDC]|\uD800[\uDC00-\uDC0B\uDC0D-\uDC26\uDC28-\uDC3A\uDC3C\uDC3D\uDC3F-\uDC4D\uDC50-\uDC5D\uDC80-\uDCFA\uDD40-\uDD74\uDE80-\uDE9C\uDEA0-\uDED0\uDF00-\uDF1F\uDF2D-\uDF4A\uDF50-\uDF75\uDF80-\uDF9D\uDFA0-\uDFC3\uDFC8-\uDFCF\uDFD1-\uDFD5]|\uD801[\uDC00-\uDC9D\uDCB0-\uDCD3\uDCD8-\uDCFB\uDD00-\uDD27\uDD30-\uDD63\uDE00-\uDF36\uDF40-\uDF55\uDF60-\uDF67]|\uD802[\uDC00-\uDC05\uDC08\uDC0A-\uDC35\uDC37\uDC38\uDC3C\uDC3F-\uDC55\uDC60-\uDC76\uDC80-\uDC9E\uDCE0-\uDCF2\uDCF4\uDCF5\uDD00-\uDD15\uDD20-\uDD39\uDD80-\uDDB7\uDDBE\uDDBF\uDE00\uDE10-\uDE13\uDE15-\uDE17\uDE19-\uDE33\uDE60-\uDE7C\uDE80-\uDE9C\uDEC0-\uDEC7\uDEC9-\uDEE4\uDF00-\uDF35\uDF40-\uDF55\uDF60-\uDF72\uDF80-\uDF91]|\uD803[\uDC00-\uDC48\uDC80-\uDCB2\uDCC0-\uDCF2]|\uD804[\uDC03-\uDC37\uDC83-\uDCAF\uDCD0-\uDCE8\uDD03-\uDD26\uDD50-\uDD72\uDD76\uDD83-\uDDB2\uDDC1-\uDDC4\uDDDA\uDDDC\uDE00-\uDE11\uDE13-\uDE2B\uDE80-\uDE86\uDE88\uDE8A-\uDE8D\uDE8F-\uDE9D\uDE9F-\uDEA8\uDEB0-\uDEDE\uDF05-\uDF0C\uDF0F\uDF10\uDF13-\uDF28\uDF2A-\uDF30\uDF32\uDF33\uDF35-\uDF39\uDF3D\uDF50\uDF5D-\uDF61]|\uD805[\uDC00-\uDC34\uDC47-\uDC4A\uDC80-\uDCAF\uDCC4\uDCC5\uDCC7\uDD80-\uDDAE\uDDD8-\uDDDB\uDE00-\uDE2F\uDE44\uDE80-\uDEAA\uDF00-\uDF19]|\uD806[\uDCA0-\uDCDF\uDCFF\uDE00\uDE0B-\uDE32\uDE3A\uDE50\uDE5C-\uDE83\uDE86-\uDE89\uDEC0-\uDEF8]|\uD807[\uDC00-\uDC08\uDC0A-\uDC2E\uDC40\uDC72-\uDC8F\uDD00-\uDD06\uDD08\uDD09\uDD0B-\uDD30\uDD46]|\uD808[\uDC00-\uDF99]|\uD809[\uDC00-\uDC6E\uDC80-\uDD43]|[\uD80C\uD81C-\uD820\uD840-\uD868\uD86A-\uD86C\uD86F-\uD872\uD874-\uD879][\uDC00-\uDFFF]|\uD80D[\uDC00-\uDC2E]|\uD811[\uDC00-\uDE46]|\uD81A[\uDC00-\uDE38\uDE40-\uDE5E\uDED0-\uDEED\uDF00-\uDF2F\uDF40-\uDF43\uDF63-\uDF77\uDF7D-\uDF8F]|\uD81B[\uDF00-\uDF44\uDF50\uDF93-\uDF9F\uDFE0\uDFE1]|\uD821[\uDC00-\uDFEC]|\uD822[\uDC00-\uDEF2]|\uD82C[\uDC00-\uDD1E\uDD70-\uDEFB]|\uD82F[\uDC00-\uDC6A\uDC70-\uDC7C\uDC80-\uDC88\uDC90-\uDC99]|\uD835[\uDC00-\uDC54\uDC56-\uDC9C\uDC9E\uDC9F\uDCA2\uDCA5\uDCA6\uDCA9-\uDCAC\uDCAE-\uDCB9\uDCBB\uDCBD-\uDCC3\uDCC5-\uDD05\uDD07-\uDD0A\uDD0D-\uDD14\uDD16-\uDD1C\uDD1E-\uDD39\uDD3B-\uDD3E\uDD40-\uDD44\uDD46\uDD4A-\uDD50\uDD52-\uDEA5\uDEA8-\uDEC0\uDEC2-\uDEDA\uDEDC-\uDEFA\uDEFC-\uDF14\uDF16-\uDF34\uDF36-\uDF4E\uDF50-\uDF6E\uDF70-\uDF88\uDF8A-\uDFA8\uDFAA-\uDFC2\uDFC4-\uDFCB]|\uD83A[\uDC00-\uDCC4\uDD00-\uDD43]|\uD83B[\uDE00-\uDE03\uDE05-\uDE1F\uDE21\uDE22\uDE24\uDE27\uDE29-\uDE32\uDE34-\uDE37\uDE39\uDE3B\uDE42\uDE47\uDE49\uDE4B\uDE4D-\uDE4F\uDE51\uDE52\uDE54\uDE57\uDE59\uDE5B\uDE5D\uDE5F\uDE61\uDE62\uDE64\uDE67-\uDE6A\uDE6C-\uDE72\uDE74-\uDE77\uDE79-\uDE7C\uDE7E\uDE80-\uDE89\uDE8B-\uDE9B\uDEA1-\uDEA3\uDEA5-\uDEA9\uDEAB-\uDEBB]|\uD869[\uDC00-\uDED6\uDF00-\uDFFF]|\uD86D[\uDC00-\uDF34\uDF40-\uDFFF]|\uD86E[\uDC00-\uDC1D\uDC20-\uDFFF]|\uD873[\uDC00-\uDEA1\uDEB0-\uDFFF]|\uD87A[\uDC00-\uDFE0]|\uD87E[\uDC00-\uDE1D]/;
    module.exports.ID_Continue =
      /[\xAA\xB5\xBA\xC0-\xD6\xD8-\xF6\xF8-\u02C1\u02C6-\u02D1\u02E0-\u02E4\u02EC\u02EE\u0300-\u0374\u0376\u0377\u037A-\u037D\u037F\u0386\u0388-\u038A\u038C\u038E-\u03A1\u03A3-\u03F5\u03F7-\u0481\u0483-\u0487\u048A-\u052F\u0531-\u0556\u0559\u0561-\u0587\u0591-\u05BD\u05BF\u05C1\u05C2\u05C4\u05C5\u05C7\u05D0-\u05EA\u05F0-\u05F2\u0610-\u061A\u0620-\u0669\u066E-\u06D3\u06D5-\u06DC\u06DF-\u06E8\u06EA-\u06FC\u06FF\u0710-\u074A\u074D-\u07B1\u07C0-\u07F5\u07FA\u0800-\u082D\u0840-\u085B\u0860-\u086A\u08A0-\u08B4\u08B6-\u08BD\u08D4-\u08E1\u08E3-\u0963\u0966-\u096F\u0971-\u0983\u0985-\u098C\u098F\u0990\u0993-\u09A8\u09AA-\u09B0\u09B2\u09B6-\u09B9\u09BC-\u09C4\u09C7\u09C8\u09CB-\u09CE\u09D7\u09DC\u09DD\u09DF-\u09E3\u09E6-\u09F1\u09FC\u0A01-\u0A03\u0A05-\u0A0A\u0A0F\u0A10\u0A13-\u0A28\u0A2A-\u0A30\u0A32\u0A33\u0A35\u0A36\u0A38\u0A39\u0A3C\u0A3E-\u0A42\u0A47\u0A48\u0A4B-\u0A4D\u0A51\u0A59-\u0A5C\u0A5E\u0A66-\u0A75\u0A81-\u0A83\u0A85-\u0A8D\u0A8F-\u0A91\u0A93-\u0AA8\u0AAA-\u0AB0\u0AB2\u0AB3\u0AB5-\u0AB9\u0ABC-\u0AC5\u0AC7-\u0AC9\u0ACB-\u0ACD\u0AD0\u0AE0-\u0AE3\u0AE6-\u0AEF\u0AF9-\u0AFF\u0B01-\u0B03\u0B05-\u0B0C\u0B0F\u0B10\u0B13-\u0B28\u0B2A-\u0B30\u0B32\u0B33\u0B35-\u0B39\u0B3C-\u0B44\u0B47\u0B48\u0B4B-\u0B4D\u0B56\u0B57\u0B5C\u0B5D\u0B5F-\u0B63\u0B66-\u0B6F\u0B71\u0B82\u0B83\u0B85-\u0B8A\u0B8E-\u0B90\u0B92-\u0B95\u0B99\u0B9A\u0B9C\u0B9E\u0B9F\u0BA3\u0BA4\u0BA8-\u0BAA\u0BAE-\u0BB9\u0BBE-\u0BC2\u0BC6-\u0BC8\u0BCA-\u0BCD\u0BD0\u0BD7\u0BE6-\u0BEF\u0C00-\u0C03\u0C05-\u0C0C\u0C0E-\u0C10\u0C12-\u0C28\u0C2A-\u0C39\u0C3D-\u0C44\u0C46-\u0C48\u0C4A-\u0C4D\u0C55\u0C56\u0C58-\u0C5A\u0C60-\u0C63\u0C66-\u0C6F\u0C80-\u0C83\u0C85-\u0C8C\u0C8E-\u0C90\u0C92-\u0CA8\u0CAA-\u0CB3\u0CB5-\u0CB9\u0CBC-\u0CC4\u0CC6-\u0CC8\u0CCA-\u0CCD\u0CD5\u0CD6\u0CDE\u0CE0-\u0CE3\u0CE6-\u0CEF\u0CF1\u0CF2\u0D00-\u0D03\u0D05-\u0D0C\u0D0E-\u0D10\u0D12-\u0D44\u0D46-\u0D48\u0D4A-\u0D4E\u0D54-\u0D57\u0D5F-\u0D63\u0D66-\u0D6F\u0D7A-\u0D7F\u0D82\u0D83\u0D85-\u0D96\u0D9A-\u0DB1\u0DB3-\u0DBB\u0DBD\u0DC0-\u0DC6\u0DCA\u0DCF-\u0DD4\u0DD6\u0DD8-\u0DDF\u0DE6-\u0DEF\u0DF2\u0DF3\u0E01-\u0E3A\u0E40-\u0E4E\u0E50-\u0E59\u0E81\u0E82\u0E84\u0E87\u0E88\u0E8A\u0E8D\u0E94-\u0E97\u0E99-\u0E9F\u0EA1-\u0EA3\u0EA5\u0EA7\u0EAA\u0EAB\u0EAD-\u0EB9\u0EBB-\u0EBD\u0EC0-\u0EC4\u0EC6\u0EC8-\u0ECD\u0ED0-\u0ED9\u0EDC-\u0EDF\u0F00\u0F18\u0F19\u0F20-\u0F29\u0F35\u0F37\u0F39\u0F3E-\u0F47\u0F49-\u0F6C\u0F71-\u0F84\u0F86-\u0F97\u0F99-\u0FBC\u0FC6\u1000-\u1049\u1050-\u109D\u10A0-\u10C5\u10C7\u10CD\u10D0-\u10FA\u10FC-\u1248\u124A-\u124D\u1250-\u1256\u1258\u125A-\u125D\u1260-\u1288\u128A-\u128D\u1290-\u12B0\u12B2-\u12B5\u12B8-\u12BE\u12C0\u12C2-\u12C5\u12C8-\u12D6\u12D8-\u1310\u1312-\u1315\u1318-\u135A\u135D-\u135F\u1380-\u138F\u13A0-\u13F5\u13F8-\u13FD\u1401-\u166C\u166F-\u167F\u1681-\u169A\u16A0-\u16EA\u16EE-\u16F8\u1700-\u170C\u170E-\u1714\u1720-\u1734\u1740-\u1753\u1760-\u176C\u176E-\u1770\u1772\u1773\u1780-\u17D3\u17D7\u17DC\u17DD\u17E0-\u17E9\u180B-\u180D\u1810-\u1819\u1820-\u1877\u1880-\u18AA\u18B0-\u18F5\u1900-\u191E\u1920-\u192B\u1930-\u193B\u1946-\u196D\u1970-\u1974\u1980-\u19AB\u19B0-\u19C9\u19D0-\u19D9\u1A00-\u1A1B\u1A20-\u1A5E\u1A60-\u1A7C\u1A7F-\u1A89\u1A90-\u1A99\u1AA7\u1AB0-\u1ABD\u1B00-\u1B4B\u1B50-\u1B59\u1B6B-\u1B73\u1B80-\u1BF3\u1C00-\u1C37\u1C40-\u1C49\u1C4D-\u1C7D\u1C80-\u1C88\u1CD0-\u1CD2\u1CD4-\u1CF9\u1D00-\u1DF9\u1DFB-\u1F15\u1F18-\u1F1D\u1F20-\u1F45\u1F48-\u1F4D\u1F50-\u1F57\u1F59\u1F5B\u1F5D\u1F5F-\u1F7D\u1F80-\u1FB4\u1FB6-\u1FBC\u1FBE\u1FC2-\u1FC4\u1FC6-\u1FCC\u1FD0-\u1FD3\u1FD6-\u1FDB\u1FE0-\u1FEC\u1FF2-\u1FF4\u1FF6-\u1FFC\u203F\u2040\u2054\u2071\u207F\u2090-\u209C\u20D0-\u20DC\u20E1\u20E5-\u20F0\u2102\u2107\u210A-\u2113\u2115\u2119-\u211D\u2124\u2126\u2128\u212A-\u212D\u212F-\u2139\u213C-\u213F\u2145-\u2149\u214E\u2160-\u2188\u2C00-\u2C2E\u2C30-\u2C5E\u2C60-\u2CE4\u2CEB-\u2CF3\u2D00-\u2D25\u2D27\u2D2D\u2D30-\u2D67\u2D6F\u2D7F-\u2D96\u2DA0-\u2DA6\u2DA8-\u2DAE\u2DB0-\u2DB6\u2DB8-\u2DBE\u2DC0-\u2DC6\u2DC8-\u2DCE\u2DD0-\u2DD6\u2DD8-\u2DDE\u2DE0-\u2DFF\u2E2F\u3005-\u3007\u3021-\u302F\u3031-\u3035\u3038-\u303C\u3041-\u3096\u3099\u309A\u309D-\u309F\u30A1-\u30FA\u30FC-\u30FF\u3105-\u312E\u3131-\u318E\u31A0-\u31BA\u31F0-\u31FF\u3400-\u4DB5\u4E00-\u9FEA\uA000-\uA48C\uA4D0-\uA4FD\uA500-\uA60C\uA610-\uA62B\uA640-\uA66F\uA674-\uA67D\uA67F-\uA6F1\uA717-\uA71F\uA722-\uA788\uA78B-\uA7AE\uA7B0-\uA7B7\uA7F7-\uA827\uA840-\uA873\uA880-\uA8C5\uA8D0-\uA8D9\uA8E0-\uA8F7\uA8FB\uA8FD\uA900-\uA92D\uA930-\uA953\uA960-\uA97C\uA980-\uA9C0\uA9CF-\uA9D9\uA9E0-\uA9FE\uAA00-\uAA36\uAA40-\uAA4D\uAA50-\uAA59\uAA60-\uAA76\uAA7A-\uAAC2\uAADB-\uAADD\uAAE0-\uAAEF\uAAF2-\uAAF6\uAB01-\uAB06\uAB09-\uAB0E\uAB11-\uAB16\uAB20-\uAB26\uAB28-\uAB2E\uAB30-\uAB5A\uAB5C-\uAB65\uAB70-\uABEA\uABEC\uABED\uABF0-\uABF9\uAC00-\uD7A3\uD7B0-\uD7C6\uD7CB-\uD7FB\uF900-\uFA6D\uFA70-\uFAD9\uFB00-\uFB06\uFB13-\uFB17\uFB1D-\uFB28\uFB2A-\uFB36\uFB38-\uFB3C\uFB3E\uFB40\uFB41\uFB43\uFB44\uFB46-\uFBB1\uFBD3-\uFD3D\uFD50-\uFD8F\uFD92-\uFDC7\uFDF0-\uFDFB\uFE00-\uFE0F\uFE20-\uFE2F\uFE33\uFE34\uFE4D-\uFE4F\uFE70-\uFE74\uFE76-\uFEFC\uFF10-\uFF19\uFF21-\uFF3A\uFF3F\uFF41-\uFF5A\uFF66-\uFFBE\uFFC2-\uFFC7\uFFCA-\uFFCF\uFFD2-\uFFD7\uFFDA-\uFFDC]|\uD800[\uDC00-\uDC0B\uDC0D-\uDC26\uDC28-\uDC3A\uDC3C\uDC3D\uDC3F-\uDC4D\uDC50-\uDC5D\uDC80-\uDCFA\uDD40-\uDD74\uDDFD\uDE80-\uDE9C\uDEA0-\uDED0\uDEE0\uDF00-\uDF1F\uDF2D-\uDF4A\uDF50-\uDF7A\uDF80-\uDF9D\uDFA0-\uDFC3\uDFC8-\uDFCF\uDFD1-\uDFD5]|\uD801[\uDC00-\uDC9D\uDCA0-\uDCA9\uDCB0-\uDCD3\uDCD8-\uDCFB\uDD00-\uDD27\uDD30-\uDD63\uDE00-\uDF36\uDF40-\uDF55\uDF60-\uDF67]|\uD802[\uDC00-\uDC05\uDC08\uDC0A-\uDC35\uDC37\uDC38\uDC3C\uDC3F-\uDC55\uDC60-\uDC76\uDC80-\uDC9E\uDCE0-\uDCF2\uDCF4\uDCF5\uDD00-\uDD15\uDD20-\uDD39\uDD80-\uDDB7\uDDBE\uDDBF\uDE00-\uDE03\uDE05\uDE06\uDE0C-\uDE13\uDE15-\uDE17\uDE19-\uDE33\uDE38-\uDE3A\uDE3F\uDE60-\uDE7C\uDE80-\uDE9C\uDEC0-\uDEC7\uDEC9-\uDEE6\uDF00-\uDF35\uDF40-\uDF55\uDF60-\uDF72\uDF80-\uDF91]|\uD803[\uDC00-\uDC48\uDC80-\uDCB2\uDCC0-\uDCF2]|\uD804[\uDC00-\uDC46\uDC66-\uDC6F\uDC7F-\uDCBA\uDCD0-\uDCE8\uDCF0-\uDCF9\uDD00-\uDD34\uDD36-\uDD3F\uDD50-\uDD73\uDD76\uDD80-\uDDC4\uDDCA-\uDDCC\uDDD0-\uDDDA\uDDDC\uDE00-\uDE11\uDE13-\uDE37\uDE3E\uDE80-\uDE86\uDE88\uDE8A-\uDE8D\uDE8F-\uDE9D\uDE9F-\uDEA8\uDEB0-\uDEEA\uDEF0-\uDEF9\uDF00-\uDF03\uDF05-\uDF0C\uDF0F\uDF10\uDF13-\uDF28\uDF2A-\uDF30\uDF32\uDF33\uDF35-\uDF39\uDF3C-\uDF44\uDF47\uDF48\uDF4B-\uDF4D\uDF50\uDF57\uDF5D-\uDF63\uDF66-\uDF6C\uDF70-\uDF74]|\uD805[\uDC00-\uDC4A\uDC50-\uDC59\uDC80-\uDCC5\uDCC7\uDCD0-\uDCD9\uDD80-\uDDB5\uDDB8-\uDDC0\uDDD8-\uDDDD\uDE00-\uDE40\uDE44\uDE50-\uDE59\uDE80-\uDEB7\uDEC0-\uDEC9\uDF00-\uDF19\uDF1D-\uDF2B\uDF30-\uDF39]|\uD806[\uDCA0-\uDCE9\uDCFF\uDE00-\uDE3E\uDE47\uDE50-\uDE83\uDE86-\uDE99\uDEC0-\uDEF8]|\uD807[\uDC00-\uDC08\uDC0A-\uDC36\uDC38-\uDC40\uDC50-\uDC59\uDC72-\uDC8F\uDC92-\uDCA7\uDCA9-\uDCB6\uDD00-\uDD06\uDD08\uDD09\uDD0B-\uDD36\uDD3A\uDD3C\uDD3D\uDD3F-\uDD47\uDD50-\uDD59]|\uD808[\uDC00-\uDF99]|\uD809[\uDC00-\uDC6E\uDC80-\uDD43]|[\uD80C\uD81C-\uD820\uD840-\uD868\uD86A-\uD86C\uD86F-\uD872\uD874-\uD879][\uDC00-\uDFFF]|\uD80D[\uDC00-\uDC2E]|\uD811[\uDC00-\uDE46]|\uD81A[\uDC00-\uDE38\uDE40-\uDE5E\uDE60-\uDE69\uDED0-\uDEED\uDEF0-\uDEF4\uDF00-\uDF36\uDF40-\uDF43\uDF50-\uDF59\uDF63-\uDF77\uDF7D-\uDF8F]|\uD81B[\uDF00-\uDF44\uDF50-\uDF7E\uDF8F-\uDF9F\uDFE0\uDFE1]|\uD821[\uDC00-\uDFEC]|\uD822[\uDC00-\uDEF2]|\uD82C[\uDC00-\uDD1E\uDD70-\uDEFB]|\uD82F[\uDC00-\uDC6A\uDC70-\uDC7C\uDC80-\uDC88\uDC90-\uDC99\uDC9D\uDC9E]|\uD834[\uDD65-\uDD69\uDD6D-\uDD72\uDD7B-\uDD82\uDD85-\uDD8B\uDDAA-\uDDAD\uDE42-\uDE44]|\uD835[\uDC00-\uDC54\uDC56-\uDC9C\uDC9E\uDC9F\uDCA2\uDCA5\uDCA6\uDCA9-\uDCAC\uDCAE-\uDCB9\uDCBB\uDCBD-\uDCC3\uDCC5-\uDD05\uDD07-\uDD0A\uDD0D-\uDD14\uDD16-\uDD1C\uDD1E-\uDD39\uDD3B-\uDD3E\uDD40-\uDD44\uDD46\uDD4A-\uDD50\uDD52-\uDEA5\uDEA8-\uDEC0\uDEC2-\uDEDA\uDEDC-\uDEFA\uDEFC-\uDF14\uDF16-\uDF34\uDF36-\uDF4E\uDF50-\uDF6E\uDF70-\uDF88\uDF8A-\uDFA8\uDFAA-\uDFC2\uDFC4-\uDFCB\uDFCE-\uDFFF]|\uD836[\uDE00-\uDE36\uDE3B-\uDE6C\uDE75\uDE84\uDE9B-\uDE9F\uDEA1-\uDEAF]|\uD838[\uDC00-\uDC06\uDC08-\uDC18\uDC1B-\uDC21\uDC23\uDC24\uDC26-\uDC2A]|\uD83A[\uDC00-\uDCC4\uDCD0-\uDCD6\uDD00-\uDD4A\uDD50-\uDD59]|\uD83B[\uDE00-\uDE03\uDE05-\uDE1F\uDE21\uDE22\uDE24\uDE27\uDE29-\uDE32\uDE34-\uDE37\uDE39\uDE3B\uDE42\uDE47\uDE49\uDE4B\uDE4D-\uDE4F\uDE51\uDE52\uDE54\uDE57\uDE59\uDE5B\uDE5D\uDE5F\uDE61\uDE62\uDE64\uDE67-\uDE6A\uDE6C-\uDE72\uDE74-\uDE77\uDE79-\uDE7C\uDE7E\uDE80-\uDE89\uDE8B-\uDE9B\uDEA1-\uDEA3\uDEA5-\uDEA9\uDEAB-\uDEBB]|\uD869[\uDC00-\uDED6\uDF00-\uDFFF]|\uD86D[\uDC00-\uDF34\uDF40-\uDFFF]|\uD86E[\uDC00-\uDC1D\uDC20-\uDFFF]|\uD873[\uDC00-\uDEA1\uDEB0-\uDFFF]|\uD87A[\uDC00-\uDFE0]|\uD87E[\uDC00-\uDE1D]|\uDB40[\uDD00-\uDDEF]/;
  },
});

// node_modules/.pnpm/json5@2.2.3/node_modules/json5/lib/util.js
var require_util = __commonJS({
  "node_modules/.pnpm/json5@2.2.3/node_modules/json5/lib/util.js"(exports, module) {
    var unicode = require_unicode();
    module.exports = {
      isSpaceSeparator(c) {
        return typeof c === "string" && unicode.Space_Separator.test(c);
      },
      isIdStartChar(c) {
        return (
          typeof c === "string" &&
          ((c >= "a" && c <= "z") ||
            (c >= "A" && c <= "Z") ||
            c === "$" ||
            c === "_" ||
            unicode.ID_Start.test(c))
        );
      },
      isIdContinueChar(c) {
        return (
          typeof c === "string" &&
          ((c >= "a" && c <= "z") ||
            (c >= "A" && c <= "Z") ||
            (c >= "0" && c <= "9") ||
            c === "$" ||
            c === "_" ||
            c === "\u200C" ||
            c === "\u200D" ||
            unicode.ID_Continue.test(c))
        );
      },
      isDigit(c) {
        return typeof c === "string" && /[0-9]/.test(c);
      },
      isHexDigit(c) {
        return typeof c === "string" && /[0-9A-Fa-f]/.test(c);
      },
    };
  },
});

// node_modules/.pnpm/json5@2.2.3/node_modules/json5/lib/parse.js
var require_parse = __commonJS({
  "node_modules/.pnpm/json5@2.2.3/node_modules/json5/lib/parse.js"(exports, module) {
    var util2 = require_util();
    var source;
    var parseState;
    var stack;
    var pos;
    var line;
    var column;
    var token;
    var key;
    var root;
    module.exports = function parse(text, reviver) {
      source = String(text);
      parseState = "start";
      stack = [];
      pos = 0;
      line = 1;
      column = 0;
      token = void 0;
      key = void 0;
      root = void 0;
      do {
        token = lex();
        parseStates[parseState]();
      } while (token.type !== "eof");
      if (typeof reviver === "function") {
        return internalize({ "": root }, "", reviver);
      }
      return root;
    };
    function internalize(holder, name, reviver) {
      const value = holder[name];
      if (value != null && typeof value === "object") {
        if (Array.isArray(value)) {
          for (let i = 0; i < value.length; i++) {
            const key2 = String(i);
            const replacement = internalize(value, key2, reviver);
            if (replacement === void 0) {
              delete value[key2];
            } else {
              Object.defineProperty(value, key2, {
                value: replacement,
                writable: true,
                enumerable: true,
                configurable: true,
              });
            }
          }
        } else {
          for (const key2 in value) {
            const replacement = internalize(value, key2, reviver);
            if (replacement === void 0) {
              delete value[key2];
            } else {
              Object.defineProperty(value, key2, {
                value: replacement,
                writable: true,
                enumerable: true,
                configurable: true,
              });
            }
          }
        }
      }
      return reviver.call(holder, name, value);
    }
    var lexState;
    var buffer;
    var doubleQuote;
    var sign;
    var c;
    function lex() {
      lexState = "default";
      buffer = "";
      doubleQuote = false;
      sign = 1;
      for (;;) {
        c = peek();
        const token2 = lexStates[lexState]();
        if (token2) {
          return token2;
        }
      }
    }
    function peek() {
      if (source[pos]) {
        return String.fromCodePoint(source.codePointAt(pos));
      }
    }
    function read() {
      const c2 = peek();
      if (c2 === "\n") {
        line++;
        column = 0;
      } else if (c2) {
        column += c2.length;
      } else {
        column++;
      }
      if (c2) {
        pos += c2.length;
      }
      return c2;
    }
    var lexStates = {
      default() {
        switch (c) {
          case "	":
          case "\v":
          case "\f":
          case " ":
          case "\xA0":
          case "\uFEFF":
          case "\n":
          case "\r":
          case "\u2028":
          case "\u2029":
            read();
            return;
          case "/":
            read();
            lexState = "comment";
            return;
          case void 0:
            read();
            return newToken("eof");
        }
        if (util2.isSpaceSeparator(c)) {
          read();
          return;
        }
        return lexStates[parseState]();
      },
      comment() {
        switch (c) {
          case "*":
            read();
            lexState = "multiLineComment";
            return;
          case "/":
            read();
            lexState = "singleLineComment";
            return;
        }
        throw invalidChar(read());
      },
      multiLineComment() {
        switch (c) {
          case "*":
            read();
            lexState = "multiLineCommentAsterisk";
            return;
          case void 0:
            throw invalidChar(read());
        }
        read();
      },
      multiLineCommentAsterisk() {
        switch (c) {
          case "*":
            read();
            return;
          case "/":
            read();
            lexState = "default";
            return;
          case void 0:
            throw invalidChar(read());
        }
        read();
        lexState = "multiLineComment";
      },
      singleLineComment() {
        switch (c) {
          case "\n":
          case "\r":
          case "\u2028":
          case "\u2029":
            read();
            lexState = "default";
            return;
          case void 0:
            read();
            return newToken("eof");
        }
        read();
      },
      value() {
        switch (c) {
          case "{":
          case "[":
            return newToken("punctuator", read());
          case "n":
            read();
            literal("ull");
            return newToken("null", null);
          case "t":
            read();
            literal("rue");
            return newToken("boolean", true);
          case "f":
            read();
            literal("alse");
            return newToken("boolean", false);
          case "-":
          case "+":
            if (read() === "-") {
              sign = -1;
            }
            lexState = "sign";
            return;
          case ".":
            buffer = read();
            lexState = "decimalPointLeading";
            return;
          case "0":
            buffer = read();
            lexState = "zero";
            return;
          case "1":
          case "2":
          case "3":
          case "4":
          case "5":
          case "6":
          case "7":
          case "8":
          case "9":
            buffer = read();
            lexState = "decimalInteger";
            return;
          case "I":
            read();
            literal("nfinity");
            return newToken("numeric", Infinity);
          case "N":
            read();
            literal("aN");
            return newToken("numeric", NaN);
          case '"':
          case "'":
            doubleQuote = read() === '"';
            buffer = "";
            lexState = "string";
            return;
        }
        throw invalidChar(read());
      },
      identifierNameStartEscape() {
        if (c !== "u") {
          throw invalidChar(read());
        }
        read();
        const u = unicodeEscape();
        switch (u) {
          case "$":
          case "_":
            break;
          default:
            if (!util2.isIdStartChar(u)) {
              throw invalidIdentifier();
            }
            break;
        }
        buffer += u;
        lexState = "identifierName";
      },
      identifierName() {
        switch (c) {
          case "$":
          case "_":
          case "\u200C":
          case "\u200D":
            buffer += read();
            return;
          case "\\":
            read();
            lexState = "identifierNameEscape";
            return;
        }
        if (util2.isIdContinueChar(c)) {
          buffer += read();
          return;
        }
        return newToken("identifier", buffer);
      },
      identifierNameEscape() {
        if (c !== "u") {
          throw invalidChar(read());
        }
        read();
        const u = unicodeEscape();
        switch (u) {
          case "$":
          case "_":
          case "\u200C":
          case "\u200D":
            break;
          default:
            if (!util2.isIdContinueChar(u)) {
              throw invalidIdentifier();
            }
            break;
        }
        buffer += u;
        lexState = "identifierName";
      },
      sign() {
        switch (c) {
          case ".":
            buffer = read();
            lexState = "decimalPointLeading";
            return;
          case "0":
            buffer = read();
            lexState = "zero";
            return;
          case "1":
          case "2":
          case "3":
          case "4":
          case "5":
          case "6":
          case "7":
          case "8":
          case "9":
            buffer = read();
            lexState = "decimalInteger";
            return;
          case "I":
            read();
            literal("nfinity");
            return newToken("numeric", sign * Infinity);
          case "N":
            read();
            literal("aN");
            return newToken("numeric", NaN);
        }
        throw invalidChar(read());
      },
      zero() {
        switch (c) {
          case ".":
            buffer += read();
            lexState = "decimalPoint";
            return;
          case "e":
          case "E":
            buffer += read();
            lexState = "decimalExponent";
            return;
          case "x":
          case "X":
            buffer += read();
            lexState = "hexadecimal";
            return;
        }
        return newToken("numeric", sign * 0);
      },
      decimalInteger() {
        switch (c) {
          case ".":
            buffer += read();
            lexState = "decimalPoint";
            return;
          case "e":
          case "E":
            buffer += read();
            lexState = "decimalExponent";
            return;
        }
        if (util2.isDigit(c)) {
          buffer += read();
          return;
        }
        return newToken("numeric", sign * Number(buffer));
      },
      decimalPointLeading() {
        if (util2.isDigit(c)) {
          buffer += read();
          lexState = "decimalFraction";
          return;
        }
        throw invalidChar(read());
      },
      decimalPoint() {
        switch (c) {
          case "e":
          case "E":
            buffer += read();
            lexState = "decimalExponent";
            return;
        }
        if (util2.isDigit(c)) {
          buffer += read();
          lexState = "decimalFraction";
          return;
        }
        return newToken("numeric", sign * Number(buffer));
      },
      decimalFraction() {
        switch (c) {
          case "e":
          case "E":
            buffer += read();
            lexState = "decimalExponent";
            return;
        }
        if (util2.isDigit(c)) {
          buffer += read();
          return;
        }
        return newToken("numeric", sign * Number(buffer));
      },
      decimalExponent() {
        switch (c) {
          case "+":
          case "-":
            buffer += read();
            lexState = "decimalExponentSign";
            return;
        }
        if (util2.isDigit(c)) {
          buffer += read();
          lexState = "decimalExponentInteger";
          return;
        }
        throw invalidChar(read());
      },
      decimalExponentSign() {
        if (util2.isDigit(c)) {
          buffer += read();
          lexState = "decimalExponentInteger";
          return;
        }
        throw invalidChar(read());
      },
      decimalExponentInteger() {
        if (util2.isDigit(c)) {
          buffer += read();
          return;
        }
        return newToken("numeric", sign * Number(buffer));
      },
      hexadecimal() {
        if (util2.isHexDigit(c)) {
          buffer += read();
          lexState = "hexadecimalInteger";
          return;
        }
        throw invalidChar(read());
      },
      hexadecimalInteger() {
        if (util2.isHexDigit(c)) {
          buffer += read();
          return;
        }
        return newToken("numeric", sign * Number(buffer));
      },
      string() {
        switch (c) {
          case "\\":
            read();
            buffer += escape();
            return;
          case '"':
            if (doubleQuote) {
              read();
              return newToken("string", buffer);
            }
            buffer += read();
            return;
          case "'":
            if (!doubleQuote) {
              read();
              return newToken("string", buffer);
            }
            buffer += read();
            return;
          case "\n":
          case "\r":
            throw invalidChar(read());
          case "\u2028":
          case "\u2029":
            separatorChar(c);
            break;
          case void 0:
            throw invalidChar(read());
        }
        buffer += read();
      },
      start() {
        switch (c) {
          case "{":
          case "[":
            return newToken("punctuator", read());
        }
        lexState = "value";
      },
      beforePropertyName() {
        switch (c) {
          case "$":
          case "_":
            buffer = read();
            lexState = "identifierName";
            return;
          case "\\":
            read();
            lexState = "identifierNameStartEscape";
            return;
          case "}":
            return newToken("punctuator", read());
          case '"':
          case "'":
            doubleQuote = read() === '"';
            lexState = "string";
            return;
        }
        if (util2.isIdStartChar(c)) {
          buffer += read();
          lexState = "identifierName";
          return;
        }
        throw invalidChar(read());
      },
      afterPropertyName() {
        if (c === ":") {
          return newToken("punctuator", read());
        }
        throw invalidChar(read());
      },
      beforePropertyValue() {
        lexState = "value";
      },
      afterPropertyValue() {
        switch (c) {
          case ",":
          case "}":
            return newToken("punctuator", read());
        }
        throw invalidChar(read());
      },
      beforeArrayValue() {
        if (c === "]") {
          return newToken("punctuator", read());
        }
        lexState = "value";
      },
      afterArrayValue() {
        switch (c) {
          case ",":
          case "]":
            return newToken("punctuator", read());
        }
        throw invalidChar(read());
      },
      end() {
        throw invalidChar(read());
      },
    };
    function newToken(type, value) {
      return {
        type,
        value,
        line,
        column,
      };
    }
    function literal(s) {
      for (const c2 of s) {
        const p = peek();
        if (p !== c2) {
          throw invalidChar(read());
        }
        read();
      }
    }
    function escape() {
      const c2 = peek();
      switch (c2) {
        case "b":
          read();
          return "\b";
        case "f":
          read();
          return "\f";
        case "n":
          read();
          return "\n";
        case "r":
          read();
          return "\r";
        case "t":
          read();
          return "	";
        case "v":
          read();
          return "\v";
        case "0":
          read();
          if (util2.isDigit(peek())) {
            throw invalidChar(read());
          }
          return "\0";
        case "x":
          read();
          return hexEscape();
        case "u":
          read();
          return unicodeEscape();
        case "\n":
        case "\u2028":
        case "\u2029":
          read();
          return "";
        case "\r":
          read();
          if (peek() === "\n") {
            read();
          }
          return "";
        case "1":
        case "2":
        case "3":
        case "4":
        case "5":
        case "6":
        case "7":
        case "8":
        case "9":
          throw invalidChar(read());
        case void 0:
          throw invalidChar(read());
      }
      return read();
    }
    function hexEscape() {
      let buffer2 = "";
      let c2 = peek();
      if (!util2.isHexDigit(c2)) {
        throw invalidChar(read());
      }
      buffer2 += read();
      c2 = peek();
      if (!util2.isHexDigit(c2)) {
        throw invalidChar(read());
      }
      buffer2 += read();
      return String.fromCodePoint(parseInt(buffer2, 16));
    }
    function unicodeEscape() {
      let buffer2 = "";
      let count = 4;
      while (count-- > 0) {
        const c2 = peek();
        if (!util2.isHexDigit(c2)) {
          throw invalidChar(read());
        }
        buffer2 += read();
      }
      return String.fromCodePoint(parseInt(buffer2, 16));
    }
    var parseStates = {
      start() {
        if (token.type === "eof") {
          throw invalidEOF();
        }
        push();
      },
      beforePropertyName() {
        switch (token.type) {
          case "identifier":
          case "string":
            key = token.value;
            parseState = "afterPropertyName";
            return;
          case "punctuator":
            pop();
            return;
          case "eof":
            throw invalidEOF();
        }
      },
      afterPropertyName() {
        if (token.type === "eof") {
          throw invalidEOF();
        }
        parseState = "beforePropertyValue";
      },
      beforePropertyValue() {
        if (token.type === "eof") {
          throw invalidEOF();
        }
        push();
      },
      beforeArrayValue() {
        if (token.type === "eof") {
          throw invalidEOF();
        }
        if (token.type === "punctuator" && token.value === "]") {
          pop();
          return;
        }
        push();
      },
      afterPropertyValue() {
        if (token.type === "eof") {
          throw invalidEOF();
        }
        switch (token.value) {
          case ",":
            parseState = "beforePropertyName";
            return;
          case "}":
            pop();
        }
      },
      afterArrayValue() {
        if (token.type === "eof") {
          throw invalidEOF();
        }
        switch (token.value) {
          case ",":
            parseState = "beforeArrayValue";
            return;
          case "]":
            pop();
        }
      },
      end() {},
    };
    function push() {
      let value;
      switch (token.type) {
        case "punctuator":
          switch (token.value) {
            case "{":
              value = {};
              break;
            case "[":
              value = [];
              break;
          }
          break;
        case "null":
        case "boolean":
        case "numeric":
        case "string":
          value = token.value;
          break;
      }
      if (root === void 0) {
        root = value;
      } else {
        const parent = stack[stack.length - 1];
        if (Array.isArray(parent)) {
          parent.push(value);
        } else {
          Object.defineProperty(parent, key, {
            value,
            writable: true,
            enumerable: true,
            configurable: true,
          });
        }
      }
      if (value !== null && typeof value === "object") {
        stack.push(value);
        if (Array.isArray(value)) {
          parseState = "beforeArrayValue";
        } else {
          parseState = "beforePropertyName";
        }
      } else {
        const current = stack[stack.length - 1];
        if (current == null) {
          parseState = "end";
        } else if (Array.isArray(current)) {
          parseState = "afterArrayValue";
        } else {
          parseState = "afterPropertyValue";
        }
      }
    }
    function pop() {
      stack.pop();
      const current = stack[stack.length - 1];
      if (current == null) {
        parseState = "end";
      } else if (Array.isArray(current)) {
        parseState = "afterArrayValue";
      } else {
        parseState = "afterPropertyValue";
      }
    }
    function invalidChar(c2) {
      if (c2 === void 0) {
        return syntaxError(`JSON5: invalid end of input at ${line}:${column}`);
      }
      return syntaxError(`JSON5: invalid character '${formatChar(c2)}' at ${line}:${column}`);
    }
    function invalidEOF() {
      return syntaxError(`JSON5: invalid end of input at ${line}:${column}`);
    }
    function invalidIdentifier() {
      column -= 5;
      return syntaxError(`JSON5: invalid identifier character at ${line}:${column}`);
    }
    function separatorChar(c2) {
      console.warn(
        `JSON5: '${formatChar(c2)}' in strings is not valid ECMAScript; consider escaping`,
      );
    }
    function formatChar(c2) {
      const replacements = {
        "'": "\\'",
        '"': '\\"',
        "\\": "\\\\",
        "\b": "\\b",
        "\f": "\\f",
        "\n": "\\n",
        "\r": "\\r",
        "	": "\\t",
        "\v": "\\v",
        "\0": "\\0",
        "\u2028": "\\u2028",
        "\u2029": "\\u2029",
      };
      if (replacements[c2]) {
        return replacements[c2];
      }
      if (c2 < " ") {
        const hexString = c2.charCodeAt(0).toString(16);
        return "\\x" + ("00" + hexString).substring(hexString.length);
      }
      return c2;
    }
    function syntaxError(message) {
      const err2 = new SyntaxError(message);
      err2.lineNumber = line;
      err2.columnNumber = column;
      return err2;
    }
  },
});

// node_modules/.pnpm/json5@2.2.3/node_modules/json5/lib/stringify.js
var require_stringify = __commonJS({
  "node_modules/.pnpm/json5@2.2.3/node_modules/json5/lib/stringify.js"(exports, module) {
    var util2 = require_util();
    module.exports = function stringify(value, replacer, space) {
      const stack = [];
      let indent = "";
      let propertyList;
      let replacerFunc;
      let gap = "";
      let quote;
      if (replacer != null && typeof replacer === "object" && !Array.isArray(replacer)) {
        space = replacer.space;
        quote = replacer.quote;
        replacer = replacer.replacer;
      }
      if (typeof replacer === "function") {
        replacerFunc = replacer;
      } else if (Array.isArray(replacer)) {
        propertyList = [];
        for (const v of replacer) {
          let item;
          if (typeof v === "string") {
            item = v;
          } else if (typeof v === "number" || v instanceof String || v instanceof Number) {
            item = String(v);
          }
          if (item !== void 0 && propertyList.indexOf(item) < 0) {
            propertyList.push(item);
          }
        }
      }
      if (space instanceof Number) {
        space = Number(space);
      } else if (space instanceof String) {
        space = String(space);
      }
      if (typeof space === "number") {
        if (space > 0) {
          space = Math.min(10, Math.floor(space));
          gap = "          ".substr(0, space);
        }
      } else if (typeof space === "string") {
        gap = space.substr(0, 10);
      }
      return serializeProperty("", { "": value });
      function serializeProperty(key, holder) {
        let value2 = holder[key];
        if (value2 != null) {
          if (typeof value2.toJSON5 === "function") {
            value2 = value2.toJSON5(key);
          } else if (typeof value2.toJSON === "function") {
            value2 = value2.toJSON(key);
          }
        }
        if (replacerFunc) {
          value2 = replacerFunc.call(holder, key, value2);
        }
        if (value2 instanceof Number) {
          value2 = Number(value2);
        } else if (value2 instanceof String) {
          value2 = String(value2);
        } else if (value2 instanceof Boolean) {
          value2 = value2.valueOf();
        }
        switch (value2) {
          case null:
            return "null";
          case true:
            return "true";
          case false:
            return "false";
        }
        if (typeof value2 === "string") {
          return quoteString(value2, false);
        }
        if (typeof value2 === "number") {
          return String(value2);
        }
        if (typeof value2 === "object") {
          return Array.isArray(value2) ? serializeArray(value2) : serializeObject(value2);
        }
        return void 0;
      }
      function quoteString(value2) {
        const quotes = {
          "'": 0.1,
          '"': 0.2,
        };
        const replacements = {
          "'": "\\'",
          '"': '\\"',
          "\\": "\\\\",
          "\b": "\\b",
          "\f": "\\f",
          "\n": "\\n",
          "\r": "\\r",
          "	": "\\t",
          "\v": "\\v",
          "\0": "\\0",
          "\u2028": "\\u2028",
          "\u2029": "\\u2029",
        };
        let product = "";
        for (let i = 0; i < value2.length; i++) {
          const c = value2[i];
          switch (c) {
            case "'":
            case '"':
              quotes[c]++;
              product += c;
              continue;
            case "\0":
              if (util2.isDigit(value2[i + 1])) {
                product += "\\x00";
                continue;
              }
          }
          if (replacements[c]) {
            product += replacements[c];
            continue;
          }
          if (c < " ") {
            let hexString = c.charCodeAt(0).toString(16);
            product += "\\x" + ("00" + hexString).substring(hexString.length);
            continue;
          }
          product += c;
        }
        const quoteChar =
          quote || Object.keys(quotes).reduce((a, b) => (quotes[a] < quotes[b] ? a : b));
        product = product.replace(new RegExp(quoteChar, "g"), replacements[quoteChar]);
        return quoteChar + product + quoteChar;
      }
      function serializeObject(value2) {
        if (stack.indexOf(value2) >= 0) {
          throw TypeError("Converting circular structure to JSON5");
        }
        stack.push(value2);
        let stepback = indent;
        indent = indent + gap;
        let keys = propertyList || Object.keys(value2);
        let partial = [];
        for (const key of keys) {
          const propertyString = serializeProperty(key, value2);
          if (propertyString !== void 0) {
            let member = serializeKey(key) + ":";
            if (gap !== "") {
              member += " ";
            }
            member += propertyString;
            partial.push(member);
          }
        }
        let final;
        if (partial.length === 0) {
          final = "{}";
        } else {
          let properties;
          if (gap === "") {
            properties = partial.join(",");
            final = "{" + properties + "}";
          } else {
            let separator = ",\n" + indent;
            properties = partial.join(separator);
            final = "{\n" + indent + properties + ",\n" + stepback + "}";
          }
        }
        stack.pop();
        indent = stepback;
        return final;
      }
      function serializeKey(key) {
        if (key.length === 0) {
          return quoteString(key, true);
        }
        const firstChar = String.fromCodePoint(key.codePointAt(0));
        if (!util2.isIdStartChar(firstChar)) {
          return quoteString(key, true);
        }
        for (let i = firstChar.length; i < key.length; i++) {
          if (!util2.isIdContinueChar(String.fromCodePoint(key.codePointAt(i)))) {
            return quoteString(key, true);
          }
        }
        return key;
      }
      function serializeArray(value2) {
        if (stack.indexOf(value2) >= 0) {
          throw TypeError("Converting circular structure to JSON5");
        }
        stack.push(value2);
        let stepback = indent;
        indent = indent + gap;
        let partial = [];
        for (let i = 0; i < value2.length; i++) {
          const propertyString = serializeProperty(String(i), value2);
          partial.push(propertyString !== void 0 ? propertyString : "null");
        }
        let final;
        if (partial.length === 0) {
          final = "[]";
        } else {
          if (gap === "") {
            let properties = partial.join(",");
            final = "[" + properties + "]";
          } else {
            let separator = ",\n" + indent;
            let properties = partial.join(separator);
            final = "[\n" + indent + properties + ",\n" + stepback + "]";
          }
        }
        stack.pop();
        indent = stepback;
        return final;
      }
    };
  },
});

// node_modules/.pnpm/json5@2.2.3/node_modules/json5/lib/index.js
var require_lib = __commonJS({
  "node_modules/.pnpm/json5@2.2.3/node_modules/json5/lib/index.js"(exports, module) {
    var parse = require_parse();
    var stringify = require_stringify();
    var JSON5 = {
      parse,
      stringify,
    };
    module.exports = JSON5;
  },
});

// src/gateway/a2a/mailbox-host.ts
import { createServer } from "node:http";
import { DatabaseSync } from "node:sqlite";

// node_modules/.pnpm/chalk@5.6.2/node_modules/chalk/source/vendor/ansi-styles/index.js
var ANSI_BACKGROUND_OFFSET = 10;
var wrapAnsi16 =
  (offset = 0) =>
  (code) =>
    `\x1B[${code + offset}m`;
var wrapAnsi256 =
  (offset = 0) =>
  (code) =>
    `\x1B[${38 + offset};5;${code}m`;
var wrapAnsi16m =
  (offset = 0) =>
  (red, green, blue) =>
    `\x1B[${38 + offset};2;${red};${green};${blue}m`;
var styles = {
  modifier: {
    reset: [0, 0],
    // 21 isn't widely supported and 22 does the same thing
    bold: [1, 22],
    dim: [2, 22],
    italic: [3, 23],
    underline: [4, 24],
    overline: [53, 55],
    inverse: [7, 27],
    hidden: [8, 28],
    strikethrough: [9, 29],
  },
  color: {
    black: [30, 39],
    red: [31, 39],
    green: [32, 39],
    yellow: [33, 39],
    blue: [34, 39],
    magenta: [35, 39],
    cyan: [36, 39],
    white: [37, 39],
    // Bright color
    blackBright: [90, 39],
    gray: [90, 39],
    // Alias of `blackBright`
    grey: [90, 39],
    // Alias of `blackBright`
    redBright: [91, 39],
    greenBright: [92, 39],
    yellowBright: [93, 39],
    blueBright: [94, 39],
    magentaBright: [95, 39],
    cyanBright: [96, 39],
    whiteBright: [97, 39],
  },
  bgColor: {
    bgBlack: [40, 49],
    bgRed: [41, 49],
    bgGreen: [42, 49],
    bgYellow: [43, 49],
    bgBlue: [44, 49],
    bgMagenta: [45, 49],
    bgCyan: [46, 49],
    bgWhite: [47, 49],
    // Bright color
    bgBlackBright: [100, 49],
    bgGray: [100, 49],
    // Alias of `bgBlackBright`
    bgGrey: [100, 49],
    // Alias of `bgBlackBright`
    bgRedBright: [101, 49],
    bgGreenBright: [102, 49],
    bgYellowBright: [103, 49],
    bgBlueBright: [104, 49],
    bgMagentaBright: [105, 49],
    bgCyanBright: [106, 49],
    bgWhiteBright: [107, 49],
  },
};
var modifierNames = Object.keys(styles.modifier);
var foregroundColorNames = Object.keys(styles.color);
var backgroundColorNames = Object.keys(styles.bgColor);
var colorNames = [...foregroundColorNames, ...backgroundColorNames];
function assembleStyles() {
  const codes = /* @__PURE__ */ new Map();
  for (const [groupName, group] of Object.entries(styles)) {
    for (const [styleName, style] of Object.entries(group)) {
      styles[styleName] = {
        open: `\x1B[${style[0]}m`,
        close: `\x1B[${style[1]}m`,
      };
      group[styleName] = styles[styleName];
      codes.set(style[0], style[1]);
    }
    Object.defineProperty(styles, groupName, {
      value: group,
      enumerable: false,
    });
  }
  Object.defineProperty(styles, "codes", {
    value: codes,
    enumerable: false,
  });
  styles.color.close = "\x1B[39m";
  styles.bgColor.close = "\x1B[49m";
  styles.color.ansi = wrapAnsi16();
  styles.color.ansi256 = wrapAnsi256();
  styles.color.ansi16m = wrapAnsi16m();
  styles.bgColor.ansi = wrapAnsi16(ANSI_BACKGROUND_OFFSET);
  styles.bgColor.ansi256 = wrapAnsi256(ANSI_BACKGROUND_OFFSET);
  styles.bgColor.ansi16m = wrapAnsi16m(ANSI_BACKGROUND_OFFSET);
  Object.defineProperties(styles, {
    rgbToAnsi256: {
      value(red, green, blue) {
        if (red === green && green === blue) {
          if (red < 8) {
            return 16;
          }
          if (red > 248) {
            return 231;
          }
          return Math.round(((red - 8) / 247) * 24) + 232;
        }
        return (
          16 +
          36 * Math.round((red / 255) * 5) +
          6 * Math.round((green / 255) * 5) +
          Math.round((blue / 255) * 5)
        );
      },
      enumerable: false,
    },
    hexToRgb: {
      value(hex2) {
        const matches = /[a-f\d]{6}|[a-f\d]{3}/i.exec(hex2.toString(16));
        if (!matches) {
          return [0, 0, 0];
        }
        let [colorString] = matches;
        if (colorString.length === 3) {
          colorString = [...colorString].map((character) => character + character).join("");
        }
        const integer = Number.parseInt(colorString, 16);
        return [
          /* eslint-disable no-bitwise */
          (integer >> 16) & 255,
          (integer >> 8) & 255,
          integer & 255,
          /* eslint-enable no-bitwise */
        ];
      },
      enumerable: false,
    },
    hexToAnsi256: {
      value: (hex2) => styles.rgbToAnsi256(...styles.hexToRgb(hex2)),
      enumerable: false,
    },
    ansi256ToAnsi: {
      value(code) {
        if (code < 8) {
          return 30 + code;
        }
        if (code < 16) {
          return 90 + (code - 8);
        }
        let red;
        let green;
        let blue;
        if (code >= 232) {
          red = ((code - 232) * 10 + 8) / 255;
          green = red;
          blue = red;
        } else {
          code -= 16;
          const remainder = code % 36;
          red = Math.floor(code / 36) / 5;
          green = Math.floor(remainder / 6) / 5;
          blue = (remainder % 6) / 5;
        }
        const value = Math.max(red, green, blue) * 2;
        if (value === 0) {
          return 30;
        }
        let result = 30 + ((Math.round(blue) << 2) | (Math.round(green) << 1) | Math.round(red));
        if (value === 2) {
          result += 60;
        }
        return result;
      },
      enumerable: false,
    },
    rgbToAnsi: {
      value: (red, green, blue) => styles.ansi256ToAnsi(styles.rgbToAnsi256(red, green, blue)),
      enumerable: false,
    },
    hexToAnsi: {
      value: (hex2) => styles.ansi256ToAnsi(styles.hexToAnsi256(hex2)),
      enumerable: false,
    },
  });
  return styles;
}
var ansiStyles = assembleStyles();
var ansi_styles_default = ansiStyles;

import os from "node:os";
// node_modules/.pnpm/chalk@5.6.2/node_modules/chalk/source/vendor/supports-color/index.js
import process2 from "node:process";
import tty from "node:tty";
function hasFlag(flag, argv = globalThis.Deno ? globalThis.Deno.args : process2.argv) {
  const prefix = flag.startsWith("-") ? "" : flag.length === 1 ? "-" : "--";
  const position = argv.indexOf(prefix + flag);
  const terminatorPosition = argv.indexOf("--");
  return position !== -1 && (terminatorPosition === -1 || position < terminatorPosition);
}
var { env } = process2;
var flagForceColor;
if (
  hasFlag("no-color") ||
  hasFlag("no-colors") ||
  hasFlag("color=false") ||
  hasFlag("color=never")
) {
  flagForceColor = 0;
} else if (
  hasFlag("color") ||
  hasFlag("colors") ||
  hasFlag("color=true") ||
  hasFlag("color=always")
) {
  flagForceColor = 1;
}
function envForceColor() {
  if ("FORCE_COLOR" in env) {
    if (env.FORCE_COLOR === "true") {
      return 1;
    }
    if (env.FORCE_COLOR === "false") {
      return 0;
    }
    return env.FORCE_COLOR.length === 0 ? 1 : Math.min(Number.parseInt(env.FORCE_COLOR, 10), 3);
  }
}
function translateLevel(level) {
  if (level === 0) {
    return false;
  }
  return {
    level,
    hasBasic: true,
    has256: level >= 2,
    has16m: level >= 3,
  };
}
function _supportsColor(haveStream, { streamIsTTY, sniffFlags = true } = {}) {
  const noFlagForceColor = envForceColor();
  if (noFlagForceColor !== void 0) {
    flagForceColor = noFlagForceColor;
  }
  const forceColor = sniffFlags ? flagForceColor : noFlagForceColor;
  if (forceColor === 0) {
    return 0;
  }
  if (sniffFlags) {
    if (hasFlag("color=16m") || hasFlag("color=full") || hasFlag("color=truecolor")) {
      return 3;
    }
    if (hasFlag("color=256")) {
      return 2;
    }
  }
  if ("TF_BUILD" in env && "AGENT_NAME" in env) {
    return 1;
  }
  if (haveStream && !streamIsTTY && forceColor === void 0) {
    return 0;
  }
  const min = forceColor || 0;
  if (env.TERM === "dumb") {
    return min;
  }
  if (process2.platform === "win32") {
    const osRelease = os.release().split(".");
    if (Number(osRelease[0]) >= 10 && Number(osRelease[2]) >= 10586) {
      return Number(osRelease[2]) >= 14931 ? 3 : 2;
    }
    return 1;
  }
  if ("CI" in env) {
    if (["GITHUB_ACTIONS", "GITEA_ACTIONS", "CIRCLECI"].some((key) => key in env)) {
      return 3;
    }
    if (
      ["TRAVIS", "APPVEYOR", "GITLAB_CI", "BUILDKITE", "DRONE"].some((sign) => sign in env) ||
      env.CI_NAME === "codeship"
    ) {
      return 1;
    }
    return min;
  }
  if ("TEAMCITY_VERSION" in env) {
    return /^(9\.(0*[1-9]\d*)\.|\d{2,}\.)/.test(env.TEAMCITY_VERSION) ? 1 : 0;
  }
  if (env.COLORTERM === "truecolor") {
    return 3;
  }
  if (env.TERM === "xterm-kitty") {
    return 3;
  }
  if (env.TERM === "xterm-ghostty") {
    return 3;
  }
  if (env.TERM === "wezterm") {
    return 3;
  }
  if ("TERM_PROGRAM" in env) {
    const version = Number.parseInt((env.TERM_PROGRAM_VERSION || "").split(".")[0], 10);
    switch (env.TERM_PROGRAM) {
      case "iTerm.app": {
        return version >= 3 ? 3 : 2;
      }
      case "Apple_Terminal": {
        return 2;
      }
    }
  }
  if (/-256(color)?$/i.test(env.TERM)) {
    return 2;
  }
  if (/^screen|^xterm|^vt100|^vt220|^rxvt|color|ansi|cygwin|linux/i.test(env.TERM)) {
    return 1;
  }
  if ("COLORTERM" in env) {
    return 1;
  }
  return min;
}
function createSupportsColor(stream, options = {}) {
  const level = _supportsColor(stream, {
    streamIsTTY: stream && stream.isTTY,
    ...options,
  });
  return translateLevel(level);
}
var supportsColor = {
  stdout: createSupportsColor({ isTTY: tty.isatty(1) }),
  stderr: createSupportsColor({ isTTY: tty.isatty(2) }),
};
var supports_color_default = supportsColor;

// node_modules/.pnpm/chalk@5.6.2/node_modules/chalk/source/utilities.js
function stringReplaceAll(string, substring, replacer) {
  let index = string.indexOf(substring);
  if (index === -1) {
    return string;
  }
  const substringLength = substring.length;
  let endIndex = 0;
  let returnValue = "";
  do {
    returnValue += string.slice(endIndex, index) + substring + replacer;
    endIndex = index + substringLength;
    index = string.indexOf(substring, endIndex);
  } while (index !== -1);
  returnValue += string.slice(endIndex);
  return returnValue;
}
function stringEncaseCRLFWithFirstIndex(string, prefix, postfix, index) {
  let endIndex = 0;
  let returnValue = "";
  do {
    const gotCR = string[index - 1] === "\r";
    returnValue +=
      string.slice(endIndex, gotCR ? index - 1 : index) +
      prefix +
      (gotCR ? "\r\n" : "\n") +
      postfix;
    endIndex = index + 1;
    index = string.indexOf("\n", endIndex);
  } while (index !== -1);
  returnValue += string.slice(endIndex);
  return returnValue;
}

// node_modules/.pnpm/chalk@5.6.2/node_modules/chalk/source/index.js
var { stdout: stdoutColor, stderr: stderrColor } = supports_color_default;
var GENERATOR = /* @__PURE__ */ Symbol("GENERATOR");
var STYLER = /* @__PURE__ */ Symbol("STYLER");
var IS_EMPTY = /* @__PURE__ */ Symbol("IS_EMPTY");
var levelMapping = ["ansi", "ansi", "ansi256", "ansi16m"];
var styles2 = /* @__PURE__ */ Object.create(null);
var applyOptions = (object, options = {}) => {
  if (
    options.level &&
    !(Number.isInteger(options.level) && options.level >= 0 && options.level <= 3)
  ) {
    throw new Error("The `level` option should be an integer from 0 to 3");
  }
  const colorLevel = stdoutColor ? stdoutColor.level : 0;
  object.level = options.level === void 0 ? colorLevel : options.level;
};
var Chalk = class {
  constructor(options) {
    return chalkFactory(options);
  }
};
var chalkFactory = (options) => {
  const chalk2 = (...strings) => strings.join(" ");
  applyOptions(chalk2, options);
  Object.setPrototypeOf(chalk2, createChalk.prototype);
  return chalk2;
};
function createChalk(options) {
  return chalkFactory(options);
}
Object.setPrototypeOf(createChalk.prototype, Function.prototype);
for (const [styleName, style] of Object.entries(ansi_styles_default)) {
  styles2[styleName] = {
    get() {
      const builder = createBuilder(
        this,
        createStyler(style.open, style.close, this[STYLER]),
        this[IS_EMPTY],
      );
      Object.defineProperty(this, styleName, { value: builder });
      return builder;
    },
  };
}
styles2.visible = {
  get() {
    const builder = createBuilder(this, this[STYLER], true);
    Object.defineProperty(this, "visible", { value: builder });
    return builder;
  },
};
var getModelAnsi = (model, level, type, ...arguments_) => {
  if (model === "rgb") {
    if (level === "ansi16m") {
      return ansi_styles_default[type].ansi16m(...arguments_);
    }
    if (level === "ansi256") {
      return ansi_styles_default[type].ansi256(ansi_styles_default.rgbToAnsi256(...arguments_));
    }
    return ansi_styles_default[type].ansi(ansi_styles_default.rgbToAnsi(...arguments_));
  }
  if (model === "hex") {
    return getModelAnsi("rgb", level, type, ...ansi_styles_default.hexToRgb(...arguments_));
  }
  return ansi_styles_default[type][model](...arguments_);
};
var usedModels = ["rgb", "hex", "ansi256"];
for (const model of usedModels) {
  styles2[model] = {
    get() {
      const { level } = this;
      return function (...arguments_) {
        const styler = createStyler(
          getModelAnsi(model, levelMapping[level], "color", ...arguments_),
          ansi_styles_default.color.close,
          this[STYLER],
        );
        return createBuilder(this, styler, this[IS_EMPTY]);
      };
    },
  };
  const bgModel = "bg" + model[0].toUpperCase() + model.slice(1);
  styles2[bgModel] = {
    get() {
      const { level } = this;
      return function (...arguments_) {
        const styler = createStyler(
          getModelAnsi(model, levelMapping[level], "bgColor", ...arguments_),
          ansi_styles_default.bgColor.close,
          this[STYLER],
        );
        return createBuilder(this, styler, this[IS_EMPTY]);
      };
    },
  };
}
var proto = Object.defineProperties(() => {}, {
  ...styles2,
  level: {
    enumerable: true,
    get() {
      return this[GENERATOR].level;
    },
    set(level) {
      this[GENERATOR].level = level;
    },
  },
});
var createStyler = (open, close, parent) => {
  let openAll;
  let closeAll;
  if (parent === void 0) {
    openAll = open;
    closeAll = close;
  } else {
    openAll = parent.openAll + open;
    closeAll = close + parent.closeAll;
  }
  return {
    open,
    close,
    openAll,
    closeAll,
    parent,
  };
};
var createBuilder = (self, _styler, _isEmpty) => {
  const builder = (...arguments_) =>
    applyStyle(builder, arguments_.length === 1 ? "" + arguments_[0] : arguments_.join(" "));
  Object.setPrototypeOf(builder, proto);
  builder[GENERATOR] = self;
  builder[STYLER] = _styler;
  builder[IS_EMPTY] = _isEmpty;
  return builder;
};
var applyStyle = (self, string) => {
  if (self.level <= 0 || !string) {
    return self[IS_EMPTY] ? "" : string;
  }
  let styler = self[STYLER];
  if (styler === void 0) {
    return string;
  }
  const { openAll, closeAll } = styler;
  if (string.includes("\x1B")) {
    while (styler !== void 0) {
      string = stringReplaceAll(string, styler.close, styler.open);
      styler = styler.parent;
    }
  }
  const lfIndex = string.indexOf("\n");
  if (lfIndex !== -1) {
    string = stringEncaseCRLFWithFirstIndex(string, closeAll, openAll, lfIndex);
  }
  return openAll + string + closeAll;
};
Object.defineProperties(createChalk.prototype, styles2);
var chalk = createChalk();
var chalkStderr = createChalk({ level: stderrColor ? stderrColor.level : 0 });
var source_default = chalk;

// src/utils.ts
import fs5 from "node:fs";
// src/config/paths.ts
import fs from "node:fs";
import os5 from "node:os";
import os3 from "node:os";
// src/infra/home-dir.ts
import os2 from "node:os";
// src/plugins/registry.ts
import path6 from "node:path";
import path5 from "node:path";
import path2 from "node:path";
import path from "node:path";
function normalize(value) {
  const trimmed = value?.trim();
  return trimmed ? trimmed : void 0;
}
function resolveEffectiveHomeDir(env2 = process.env, homedir = os2.homedir) {
  const raw = resolveRawHomeDir(env2, homedir);
  return raw ? path.resolve(raw) : void 0;
}
function resolveRawHomeDir(env2, homedir) {
  const explicitHome = normalize(env2.BITTERBOT_HOME);
  if (explicitHome) {
    if (explicitHome === "~" || explicitHome.startsWith("~/") || explicitHome.startsWith("~\\")) {
      const fallbackHome =
        normalize(env2.HOME) ?? normalize(env2.USERPROFILE) ?? normalizeSafe(homedir);
      if (fallbackHome) {
        return explicitHome.replace(/^~(?=$|[\\/])/, fallbackHome);
      }
      return void 0;
    }
    return explicitHome;
  }
  const envHome = normalize(env2.HOME);
  if (envHome) {
    return envHome;
  }
  const userProfile = normalize(env2.USERPROFILE);
  if (userProfile) {
    return userProfile;
  }
  return normalizeSafe(homedir);
}
function normalizeSafe(homedir) {
  try {
    return normalize(homedir());
  } catch {
    return void 0;
  }
}
function resolveRequiredHomeDir(env2 = process.env, homedir = os2.homedir) {
  return resolveEffectiveHomeDir(env2, homedir) ?? path.resolve(process.cwd());
}
function expandHomePrefix(input, opts) {
  if (!input.startsWith("~")) {
    return input;
  }
  const home =
    normalize(opts?.home) ??
    resolveEffectiveHomeDir(opts?.env ?? process.env, opts?.homedir ?? os2.homedir);
  if (!home) {
    return input;
  }
  return input.replace(/^~(?=$|[\\/])/, home);
}

// src/config/paths.ts
function resolveIsNixMode(env2 = process.env) {
  return env2.BITTERBOT_NIX_MODE === "1";
}
var isNixMode = resolveIsNixMode();
var STATE_DIRNAME = ".bitterbot";
var CONFIG_FILENAME = "bitterbot.json";
function resolveDefaultHomeDir() {
  return resolveRequiredHomeDir(process.env, os3.homedir);
}
function envHomedir(env2) {
  return () => resolveRequiredHomeDir(env2, os3.homedir);
}
function stateDir(homedir = resolveDefaultHomeDir) {
  return path2.join(homedir(), STATE_DIRNAME);
}
function resolveStateDir(env2 = process.env, homedir = envHomedir(env2)) {
  const effectiveHomedir = () => resolveRequiredHomeDir(env2, homedir);
  const override = env2.BITTERBOT_STATE_DIR?.trim();
  if (override) {
    return resolveUserPath(override, env2, effectiveHomedir);
  }
  return stateDir(effectiveHomedir);
}
function resolveUserPath(input, env2 = process.env, homedir = envHomedir(env2)) {
  const trimmed = input.trim();
  if (!trimmed) {
    return trimmed;
  }
  if (trimmed.startsWith("~")) {
    const expanded = expandHomePrefix(trimmed, {
      home: resolveRequiredHomeDir(env2, homedir),
      env: env2,
      homedir,
    });
    return path2.resolve(expanded);
  }
  return path2.resolve(trimmed);
}
var STATE_DIR = resolveStateDir();
function resolveCanonicalConfigPath(
  env2 = process.env,
  stateDir2 = resolveStateDir(env2, envHomedir(env2)),
) {
  const override = env2.BITTERBOT_CONFIG_PATH?.trim();
  if (override) {
    return resolveUserPath(override, env2, envHomedir(env2));
  }
  return path2.join(stateDir2, CONFIG_FILENAME);
}
function resolveConfigPathCandidate(env2 = process.env, homedir = envHomedir(env2)) {
  const candidates = resolveDefaultConfigCandidates(env2, homedir);
  const existing = candidates.find((candidate) => {
    try {
      return fs.existsSync(candidate);
    } catch {
      return false;
    }
  });
  if (existing) {
    return existing;
  }
  return resolveCanonicalConfigPath(env2, resolveStateDir(env2, homedir));
}
function resolveConfigPath(
  env2 = process.env,
  stateDir2 = resolveStateDir(env2, envHomedir(env2)),
  homedir = envHomedir(env2),
) {
  const override = env2.BITTERBOT_CONFIG_PATH?.trim();
  if (override) {
    return resolveUserPath(override, env2, homedir);
  }
  const stateOverride = env2.BITTERBOT_STATE_DIR?.trim();
  const candidates = [path2.join(stateDir2, CONFIG_FILENAME)];
  const existing = candidates.find((candidate) => {
    try {
      return fs.existsSync(candidate);
    } catch {
      return false;
    }
  });
  if (existing) {
    return existing;
  }
  if (stateOverride) {
    return path2.join(stateDir2, CONFIG_FILENAME);
  }
  const defaultStateDir = resolveStateDir(env2, homedir);
  if (path2.resolve(stateDir2) === path2.resolve(defaultStateDir)) {
    return resolveConfigPathCandidate(env2, homedir);
  }
  return path2.join(stateDir2, CONFIG_FILENAME);
}
var CONFIG_PATH = resolveConfigPathCandidate();
function resolveDefaultConfigCandidates(env2 = process.env, homedir = envHomedir(env2)) {
  const effectiveHomedir = () => resolveRequiredHomeDir(env2, homedir);
  const explicit = env2.BITTERBOT_CONFIG_PATH?.trim();
  if (explicit) {
    return [resolveUserPath(explicit, env2, effectiveHomedir)];
  }
  const candidates = [];
  const bitterbotStateDir = env2.BITTERBOT_STATE_DIR?.trim();
  if (bitterbotStateDir) {
    const resolved = resolveUserPath(bitterbotStateDir, env2, effectiveHomedir);
    candidates.push(path2.join(resolved, CONFIG_FILENAME));
  }
  candidates.push(path2.join(stateDir(effectiveHomedir), CONFIG_FILENAME));
  return candidates;
}

// src/logging/logger.ts
import fs4 from "node:fs";
import { createRequire } from "node:module";
import path4 from "node:path";

// node_modules/.pnpm/tslog@4.10.2/node_modules/tslog/esm/urlToObj.js
function urlToObject(url) {
  return {
    href: url.href,
    protocol: url.protocol,
    username: url.username,
    password: url.password,
    host: url.host,
    hostname: url.hostname,
    port: url.port,
    pathname: url.pathname,
    search: url.search,
    searchParams: [...url.searchParams].map(([key, value]) => ({ key, value })),
    hash: url.hash,
    origin: url.origin,
  };
}

// node_modules/.pnpm/tslog@4.10.2/node_modules/tslog/esm/prettyLogStyles.js
var prettyLogStyles = {
  reset: [0, 0],
  bold: [1, 22],
  dim: [2, 22],
  italic: [3, 23],
  underline: [4, 24],
  overline: [53, 55],
  inverse: [7, 27],
  hidden: [8, 28],
  strikethrough: [9, 29],
  black: [30, 39],
  red: [31, 39],
  green: [32, 39],
  yellow: [33, 39],
  blue: [34, 39],
  magenta: [35, 39],
  cyan: [36, 39],
  white: [37, 39],
  blackBright: [90, 39],
  redBright: [91, 39],
  greenBright: [92, 39],
  yellowBright: [93, 39],
  blueBright: [94, 39],
  magentaBright: [95, 39],
  cyanBright: [96, 39],
  whiteBright: [97, 39],
  bgBlack: [40, 49],
  bgRed: [41, 49],
  bgGreen: [42, 49],
  bgYellow: [43, 49],
  bgBlue: [44, 49],
  bgMagenta: [45, 49],
  bgCyan: [46, 49],
  bgWhite: [47, 49],
  bgBlackBright: [100, 49],
  bgRedBright: [101, 49],
  bgGreenBright: [102, 49],
  bgYellowBright: [103, 49],
  bgBlueBright: [104, 49],
  bgMagentaBright: [105, 49],
  bgCyanBright: [106, 49],
  bgWhiteBright: [107, 49],
};

// node_modules/.pnpm/tslog@4.10.2/node_modules/tslog/esm/formatTemplate.js
function formatTemplate(settings, template, values, hideUnsetPlaceholder = false) {
  const templateString = String(template);
  const ansiColorWrap = (placeholderValue, code) =>
    `\x1B[${code[0]}m${placeholderValue}\x1B[${code[1]}m`;
  const styleWrap = (value, style) => {
    if (style != null && typeof style === "string") {
      return ansiColorWrap(value, prettyLogStyles[style]);
    } else if (style != null && Array.isArray(style)) {
      return style.reduce((prevValue, thisStyle) => styleWrap(prevValue, thisStyle), value);
    } else {
      if (style != null && style[value.trim()] != null) {
        return styleWrap(value, style[value.trim()]);
      } else if (style != null && style["*"] != null) {
        return styleWrap(value, style["*"]);
      } else {
        return value;
      }
    }
  };
  const defaultStyle = null;
  return templateString.replace(/{{(.+?)}}/g, (_, placeholder) => {
    const value =
      values[placeholder] != null ? String(values[placeholder]) : hideUnsetPlaceholder ? "" : _;
    return settings.stylePrettyLogs
      ? styleWrap(value, settings?.prettyLogStyles?.[placeholder] ?? defaultStyle) +
          ansiColorWrap("", prettyLogStyles.reset)
      : value;
  });
}

// node_modules/.pnpm/tslog@4.10.2/node_modules/tslog/esm/formatNumberAddZeros.js
function formatNumberAddZeros(value, digits = 2, addNumber = 0) {
  if (value != null && isNaN(value)) {
    return "";
  }
  value = value != null ? value + addNumber : value;
  return digits === 2
    ? value == null
      ? "--"
      : value < 10
        ? "0" + value
        : value.toString()
    : value == null
      ? "---"
      : value < 10
        ? "00" + value
        : value < 100
          ? "0" + value
          : value.toString();
}

// node_modules/.pnpm/tslog@4.10.2/node_modules/tslog/esm/internal/metaFormatting.js
function buildPrettyMeta(settings, meta) {
  if (meta == null) {
    return {
      text: "",
      template: settings.prettyLogTemplate,
      placeholders: {},
    };
  }
  let template = settings.prettyLogTemplate;
  const placeholderValues = {};
  if (template.includes("{{yyyy}}.{{mm}}.{{dd}} {{hh}}:{{MM}}:{{ss}}:{{ms}}")) {
    template = template.replace(
      "{{yyyy}}.{{mm}}.{{dd}} {{hh}}:{{MM}}:{{ss}}:{{ms}}",
      "{{dateIsoStr}}",
    );
  } else {
    if (settings.prettyLogTimeZone === "UTC") {
      placeholderValues["yyyy"] = meta.date?.getUTCFullYear() ?? "----";
      placeholderValues["mm"] = formatNumberAddZeros(meta.date?.getUTCMonth(), 2, 1);
      placeholderValues["dd"] = formatNumberAddZeros(meta.date?.getUTCDate(), 2);
      placeholderValues["hh"] = formatNumberAddZeros(meta.date?.getUTCHours(), 2);
      placeholderValues["MM"] = formatNumberAddZeros(meta.date?.getUTCMinutes(), 2);
      placeholderValues["ss"] = formatNumberAddZeros(meta.date?.getUTCSeconds(), 2);
      placeholderValues["ms"] = formatNumberAddZeros(meta.date?.getUTCMilliseconds(), 3);
    } else {
      placeholderValues["yyyy"] = meta.date?.getFullYear() ?? "----";
      placeholderValues["mm"] = formatNumberAddZeros(meta.date?.getMonth(), 2, 1);
      placeholderValues["dd"] = formatNumberAddZeros(meta.date?.getDate(), 2);
      placeholderValues["hh"] = formatNumberAddZeros(meta.date?.getHours(), 2);
      placeholderValues["MM"] = formatNumberAddZeros(meta.date?.getMinutes(), 2);
      placeholderValues["ss"] = formatNumberAddZeros(meta.date?.getSeconds(), 2);
      placeholderValues["ms"] = formatNumberAddZeros(meta.date?.getMilliseconds(), 3);
    }
  }
  const dateInSettingsTimeZone =
    settings.prettyLogTimeZone === "UTC"
      ? meta.date
      : meta.date != null
        ? new Date(meta.date.getTime() - meta.date.getTimezoneOffset() * 6e4)
        : void 0;
  placeholderValues["rawIsoStr"] = dateInSettingsTimeZone?.toISOString() ?? "";
  placeholderValues["dateIsoStr"] =
    dateInSettingsTimeZone?.toISOString().replace("T", " ").replace("Z", "") ?? "";
  placeholderValues["logLevelName"] = meta.logLevelName;
  placeholderValues["fileNameWithLine"] = meta.path?.fileNameWithLine ?? "";
  placeholderValues["filePathWithLine"] = meta.path?.filePathWithLine ?? "";
  placeholderValues["fullFilePath"] = meta.path?.fullFilePath ?? "";
  let parentNamesString = settings.parentNames?.join(settings.prettyErrorParentNamesSeparator);
  parentNamesString =
    parentNamesString != null && meta.name != null
      ? parentNamesString + settings.prettyErrorParentNamesSeparator
      : void 0;
  const combinedName =
    meta.name != null || parentNamesString != null
      ? `${parentNamesString ?? ""}${meta.name ?? ""}`
      : "";
  placeholderValues["name"] = combinedName;
  placeholderValues["nameWithDelimiterPrefix"] =
    combinedName.length > 0 ? settings.prettyErrorLoggerNameDelimiter + combinedName : "";
  placeholderValues["nameWithDelimiterSuffix"] =
    combinedName.length > 0 ? combinedName + settings.prettyErrorLoggerNameDelimiter : "";
  if (settings.overwrite?.addPlaceholders != null) {
    settings.overwrite.addPlaceholders(meta, placeholderValues);
  }
  return {
    text: formatTemplate(settings, template, placeholderValues),
    template,
    placeholders: placeholderValues,
  };
}

// node_modules/.pnpm/tslog@4.10.2/node_modules/tslog/esm/internal/stackTrace.js
var DEFAULT_IGNORE_PATTERNS = [
  /(?:^|[\\/])node_modules[\\/].*tslog/i,
  /(?:^|[\\/])deps[\\/].*tslog/i,
  /tslog[\\/]+src[\\/]+internal[\\/]/i,
  /tslog[\\/]+src[\\/]BaseLogger/i,
  /tslog[\\/]+src[\\/]index/i,
];
function splitStackLines(error) {
  const stack = typeof error?.stack === "string" ? error.stack : void 0;
  if (stack == null || stack.length === 0) {
    return [];
  }
  return stack.split("\n").map((line) => line.trimEnd());
}
function sanitizeStackLines(lines) {
  return lines.filter((line) => line.length > 0 && !/^\s*Error\b/.test(line));
}
function toStackFrames(lines, parseLine) {
  const frames = [];
  for (const line of lines) {
    const frame = parseLine(line);
    if (frame != null) {
      frames.push(frame);
    }
  }
  return frames;
}
function findFirstExternalFrameIndex(frames, ignorePatterns = DEFAULT_IGNORE_PATTERNS) {
  for (let index = 0; index < frames.length; index += 1) {
    const frame = frames[index];
    const filePathCandidate = frame.filePath ?? "";
    const fullPathCandidate = frame.fullFilePath ?? "";
    if (
      !ignorePatterns.some(
        (pattern) => pattern.test(filePathCandidate) || pattern.test(fullPathCandidate),
      )
    ) {
      return index;
    }
  }
  return 0;
}
function getCleanStackLines(error) {
  return sanitizeStackLines(splitStackLines(error));
}
function buildStackTrace(error, parseLine) {
  return toStackFrames(getCleanStackLines(error), parseLine);
}
function clampIndex(index, maxExclusive) {
  if (index < 0) {
    return 0;
  }
  if (index >= maxExclusive) {
    return Math.max(0, maxExclusive - 1);
  }
  return index;
}
function getDefaultIgnorePatterns() {
  return [...DEFAULT_IGNORE_PATTERNS];
}

// node_modules/.pnpm/tslog@4.10.2/node_modules/tslog/esm/internal/errorUtils.js
var DEFAULT_CAUSE_DEPTH = 5;
function collectErrorCauses(error, options = {}) {
  const maxDepth = options.maxDepth ?? DEFAULT_CAUSE_DEPTH;
  const causes = [];
  const visited = /* @__PURE__ */ new Set();
  let current = error;
  let depth = 0;
  while (current != null && depth < maxDepth) {
    const cause = current?.cause;
    if (cause == null || visited.has(cause)) {
      break;
    }
    visited.add(cause);
    causes.push(toError(cause));
    current = cause;
    depth += 1;
  }
  return causes;
}
function toError(value) {
  if (value instanceof Error) {
    return value;
  }
  const error = new Error(typeof value === "string" ? value : JSON.stringify(value));
  if (typeof value === "object" && value != null) {
    Object.assign(error, value);
  }
  return error;
}

// node_modules/.pnpm/tslog@4.10.2/node_modules/tslog/esm/internal/jsonStringifyRecursive.js
function jsonStringifyRecursive(obj) {
  const cache = /* @__PURE__ */ new Set();
  return JSON.stringify(obj, (key, value) => {
    if (typeof value === "object" && value !== null) {
      if (cache.has(value)) {
        return "[Circular]";
      }
      cache.add(value);
    }
    if (typeof value === "bigint") {
      return `${value}`;
    }
    if (typeof value === "undefined") {
      return "[undefined]";
    }
    return value;
  });
}

// node_modules/.pnpm/tslog@4.10.2/node_modules/tslog/esm/internal/util.inspect.polyfill.js
function inspect(obj, opts) {
  const ctx = {
    seen: [],
    stylize: stylizeNoColor,
  };
  if (opts != null) {
    _extend(ctx, opts);
  }
  if (isUndefined(ctx.showHidden)) ctx.showHidden = false;
  if (isUndefined(ctx.depth)) ctx.depth = 2;
  if (isUndefined(ctx.colors)) ctx.colors = true;
  if (isUndefined(ctx.customInspect)) ctx.customInspect = true;
  if (ctx.colors) ctx.stylize = stylizeWithColor;
  return formatValue(ctx, obj, ctx.depth);
}
inspect.colors = prettyLogStyles;
inspect.styles = {
  special: "cyan",
  number: "yellow",
  boolean: "yellow",
  undefined: "grey",
  null: "bold",
  string: "green",
  date: "magenta",
  regexp: "red",
};
function isBoolean(arg) {
  return typeof arg === "boolean";
}
function isUndefined(arg) {
  return arg === void 0;
}
function stylizeNoColor(str) {
  return str;
}
function stylizeWithColor(str, styleType) {
  const style = inspect.styles[styleType];
  if (
    style != null &&
    inspect?.colors?.[style]?.[0] != null &&
    inspect?.colors?.[style]?.[1] != null
  ) {
    return (
      "\x1B[" + inspect.colors[style][0] + "m" + str + "\x1B[" + inspect.colors[style][1] + "m"
    );
  } else {
    return str;
  }
}
function isFunction(arg) {
  return typeof arg === "function";
}
function isString(arg) {
  return typeof arg === "string";
}
function isNumber(arg) {
  return typeof arg === "number";
}
function isNull(arg) {
  return arg === null;
}
function hasOwn(obj, prop) {
  return Object.prototype.hasOwnProperty.call(obj, prop);
}
function isRegExp(re) {
  return isObject(re) && objectToString(re) === "[object RegExp]";
}
function isObject(arg) {
  return typeof arg === "object" && arg !== null;
}
function isError(e) {
  return isObject(e) && (objectToString(e) === "[object Error]" || e instanceof Error);
}
function isDate(d) {
  return isObject(d) && objectToString(d) === "[object Date]";
}
function objectToString(o) {
  return Object.prototype.toString.call(o);
}
function arrayToHash(array) {
  const hash = {};
  array.forEach((val) => {
    hash[val] = true;
  });
  return hash;
}
function formatArray(ctx, value, recurseTimes, visibleKeys, keys) {
  const output = [];
  for (let i = 0, l = value.length; i < l; ++i) {
    if (hasOwn(value, String(i))) {
      output.push(formatProperty(ctx, value, recurseTimes, visibleKeys, String(i), true));
    } else {
      output.push("");
    }
  }
  keys.forEach((key) => {
    if (!key.match(/^\d+$/)) {
      output.push(formatProperty(ctx, value, recurseTimes, visibleKeys, key, true));
    }
  });
  return output;
}
function formatError(value) {
  return "[" + Error.prototype.toString.call(value) + "]";
}
function formatValue(ctx, value, recurseTimes = 0) {
  if (
    ctx.customInspect &&
    value != null &&
    isFunction(value) &&
    value?.inspect !== inspect &&
    !(value?.constructor && value?.constructor.prototype === value)
  ) {
    if (typeof value.inspect !== "function" && value.toString != null) {
      return value.toString();
    }
    let ret = value?.inspect(recurseTimes, ctx);
    if (!isString(ret)) {
      ret = formatValue(ctx, ret, recurseTimes);
    }
    return ret;
  }
  const primitive = formatPrimitive(ctx, value);
  if (primitive) {
    return primitive;
  }
  let keys = Object.keys(value);
  const visibleKeys = arrayToHash(keys);
  try {
    if (ctx.showHidden && Object.getOwnPropertyNames) {
      keys = Object.getOwnPropertyNames(value);
    }
  } catch {}
  if (isError(value) && (keys.indexOf("message") >= 0 || keys.indexOf("description") >= 0)) {
    return formatError(value);
  }
  if (keys.length === 0) {
    if (isFunction(ctx.stylize)) {
      if (isFunction(value)) {
        const name = value.name ? ": " + value.name : "";
        return ctx.stylize("[Function" + name + "]", "special");
      }
      if (isRegExp(value)) {
        return ctx.stylize(RegExp.prototype.toString.call(value), "regexp");
      }
      if (isDate(value)) {
        return ctx.stylize(Date.prototype.toISOString.call(value), "date");
      }
      if (isError(value)) {
        return formatError(value);
      }
    } else {
      return value;
    }
  }
  let base = "";
  let array = false;
  let braces = ["{\n", "\n}"];
  if (Array.isArray(value)) {
    array = true;
    braces = ["[\n", "\n]"];
  }
  if (isFunction(value)) {
    const n = value.name ? ": " + value.name : "";
    base = " [Function" + n + "]";
  }
  if (isRegExp(value)) {
    base = " " + RegExp.prototype.toString.call(value);
  }
  if (isDate(value)) {
    base = " " + Date.prototype.toUTCString.call(value);
  }
  if (isError(value)) {
    base = " " + formatError(value);
  }
  if (keys.length === 0 && (!array || value.length == 0)) {
    return braces[0] + base + braces[1];
  }
  if (recurseTimes < 0) {
    if (isRegExp(value)) {
      return ctx.stylize(RegExp.prototype.toString.call(value), "regexp");
    } else {
      return ctx.stylize("[Object]", "special");
    }
  }
  ctx.seen.push(value);
  let output;
  if (array) {
    output = formatArray(ctx, value, recurseTimes, visibleKeys, keys);
  } else {
    output = keys.map((key) => {
      return formatProperty(ctx, value, recurseTimes, visibleKeys, key, array);
    });
  }
  ctx.seen.pop();
  return reduceToSingleString(output, base, braces);
}
function formatProperty(ctx, value, recurseTimes, visibleKeys, key, array) {
  let name, str;
  let desc = { value: void 0 };
  try {
    desc.value = value[key];
  } catch {}
  try {
    if (Object.getOwnPropertyDescriptor) {
      desc = Object.getOwnPropertyDescriptor(value, key) || desc;
    }
  } catch {}
  if (desc.get) {
    if (desc.set) {
      str = ctx.stylize("[Getter/Setter]", "special");
    } else {
      str = ctx.stylize("[Getter]", "special");
    }
  } else {
    if (desc.set) {
      str = ctx.stylize("[Setter]", "special");
    }
  }
  if (!hasOwn(visibleKeys, key)) {
    name = "[" + key + "]";
  }
  if (!str) {
    if (ctx.seen.indexOf(desc.value) < 0) {
      if (isNull(recurseTimes)) {
        str = formatValue(ctx, desc.value, void 0);
      } else {
        str = formatValue(ctx, desc.value, recurseTimes - 1);
      }
      if (str.indexOf("\n") > -1) {
        if (array) {
          str = str
            .split("\n")
            .map((line) => {
              return "  " + line;
            })
            .join("\n")
            .substr(2);
        } else {
          str =
            "\n" +
            str
              .split("\n")
              .map((line) => {
                return "   " + line;
              })
              .join("\n");
        }
      }
    } else {
      str = ctx.stylize("[Circular]", "special");
    }
  }
  if (isUndefined(name)) {
    if (array && key.match(/^\d+$/)) {
      return str;
    }
    name = JSON.stringify("" + key);
    if (name.match(/^"([a-zA-Z_][a-zA-Z_0-9]*)"$/)) {
      name = name.substr(1, name.length - 2);
      name = ctx.stylize(name, "name");
    } else {
      name = name
        .replace(/'/g, "\\'")
        .replace(/\\"/g, "\\'")
        .replace(/(^"|"$)/g, "'");
      name = ctx.stylize(name, "string");
    }
  }
  return name + ": " + str;
}
function formatPrimitive(ctx, value) {
  if (isUndefined(value)) return ctx.stylize("undefined", "undefined");
  if (isString(value)) {
    const simple =
      "'" +
      JSON.stringify(value).replace(/^"|"$/g, "").replace(/'/g, "\\'").replace(/\\"/g, "\\'") +
      "'";
    return ctx.stylize(simple, "string");
  }
  if (isNumber(value)) return ctx.stylize("" + value, "number");
  if (isBoolean(value)) return ctx.stylize("" + value, "boolean");
  if (isNull(value)) return ctx.stylize("null", "null");
}
function reduceToSingleString(output, base, braces) {
  return (
    braces[0] + (base === "" ? "" : base + "\n") + "  " + output.join(",\n  ") + " " + braces[1]
  );
}
function _extend(origin, add) {
  const typedOrigin = { ...origin };
  if (!add || !isObject(add)) return origin;
  const clonedAdd = { ...add };
  const keys = Object.keys(add);
  let i = keys.length;
  while (i--) {
    typedOrigin[keys[i]] = clonedAdd[keys[i]];
  }
  return typedOrigin;
}
function formatWithOptions(inspectOptions, ...args) {
  const ctx = {
    seen: [],
    stylize: stylizeNoColor,
  };
  if (inspectOptions != null) {
    _extend(ctx, inspectOptions);
  }
  const first = args[0];
  let a = 0;
  let str = "";
  let join = "";
  if (typeof first === "string") {
    if (args.length === 1) {
      return first;
    }
    let tempStr;
    let lastPos = 0;
    for (let i = 0; i < first.length - 1; i++) {
      if (first.charCodeAt(i) === 37) {
        const nextChar = first.charCodeAt(++i);
        if (a + 1 !== args.length) {
          switch (nextChar) {
            case 115: {
              const tempArg = args[++a];
              if (typeof tempArg === "number") {
                tempStr = formatPrimitive(ctx, tempArg);
              } else if (typeof tempArg === "bigint") {
                tempStr = formatPrimitive(ctx, tempArg);
              } else if (typeof tempArg !== "object" || tempArg === null) {
                tempStr = String(tempArg);
              } else {
                tempStr = inspect(tempArg, {
                  ...inspectOptions,
                  compact: 3,
                  colors: false,
                  depth: 0,
                });
              }
              break;
            }
            case 106:
              tempStr = jsonStringifyRecursive(args[++a]);
              break;
            case 100: {
              const tempNum = args[++a];
              if (typeof tempNum === "bigint") {
                tempStr = formatPrimitive(ctx, tempNum);
              } else if (typeof tempNum === "symbol") {
                tempStr = "NaN";
              } else {
                tempStr = formatPrimitive(ctx, tempNum);
              }
              break;
            }
            case 79:
              tempStr = inspect(args[++a], inspectOptions);
              break;
            case 111:
              tempStr = inspect(args[++a], {
                ...inspectOptions,
                showHidden: true,
                showProxy: true,
                depth: 4,
              });
              break;
            case 105: {
              const tempInteger = args[++a];
              if (typeof tempInteger === "bigint") {
                tempStr = formatPrimitive(ctx, tempInteger);
              } else if (typeof tempInteger === "symbol") {
                tempStr = "NaN";
              } else {
                tempStr = formatPrimitive(ctx, parseInt(tempStr));
              }
              break;
            }
            case 102: {
              const tempFloat = args[++a];
              if (typeof tempFloat === "symbol") {
                tempStr = "NaN";
              } else {
                tempStr = formatPrimitive(ctx, parseInt(tempFloat));
              }
              break;
            }
            case 99:
              a += 1;
              tempStr = "";
              break;
            case 37:
              str += first.slice(lastPos, i);
              lastPos = i + 1;
              continue;
            default:
              continue;
          }
          if (lastPos !== i - 1) {
            str += first.slice(lastPos, i - 1);
          }
          str += tempStr;
          lastPos = i + 1;
        } else if (nextChar === 37) {
          str += first.slice(lastPos, i);
          lastPos = i + 1;
        }
      }
    }
    if (lastPos !== 0) {
      a++;
      join = " ";
      if (lastPos < first.length) {
        str += first.slice(lastPos);
      }
    }
  }
  while (a < args.length) {
    const value = args[a];
    str += join;
    str += typeof value !== "string" ? inspect(value, inspectOptions) : value;
    join = " ";
    a++;
  }
  return str;
}

// node_modules/.pnpm/tslog@4.10.2/node_modules/tslog/esm/internal/environment.js
function safeGetCwd() {
  try {
    const nodeProcess = globalThis?.process;
    if (typeof nodeProcess?.cwd === "function") {
      return nodeProcess.cwd();
    }
  } catch {}
  try {
    const deno = globalThis?.["Deno"];
    if (typeof deno?.cwd === "function") {
      return deno.cwd();
    }
  } catch {}
  return void 0;
}
function isBrowserEnvironment() {
  return typeof window !== "undefined" && typeof document !== "undefined";
}
function consoleSupportsCssStyling() {
  if (!isBrowserEnvironment()) {
    return false;
  }
  const navigatorObj = globalThis?.navigator;
  const userAgent = navigatorObj?.userAgent ?? "";
  if (/firefox/i.test(userAgent)) {
    return true;
  }
  const windowObj = globalThis;
  if (windowObj?.CSS?.supports?.("color", "#000")) {
    return true;
  }
  return /safari/i.test(userAgent) && !/chrome/i.test(userAgent);
}

// node_modules/.pnpm/tslog@4.10.2/node_modules/tslog/esm/BaseLogger.js
function createLoggerEnvironment() {
  const runtimeInfo = detectRuntimeInfo();
  const meta = createRuntimeMeta(runtimeInfo);
  const usesBrowserStack = runtimeInfo.name === "browser" || runtimeInfo.name === "worker";
  const callerIgnorePatterns = usesBrowserStack
    ? [...getDefaultIgnorePatterns(), /node_modules[\\/].*tslog/i]
    : [...getDefaultIgnorePatterns(), /node:(?:internal|vm)/i, /\binternal[\\/]/i];
  let cachedCwd;
  const environment = {
    getMeta(
      logLevelId,
      logLevelName,
      stackDepthLevel,
      hideLogPositionForPerformance,
      name,
      parentNames,
    ) {
      return Object.assign({}, meta, {
        name,
        parentNames,
        date: /* @__PURE__ */ new Date(),
        logLevelId,
        logLevelName,
        path: !hideLogPositionForPerformance
          ? environment.getCallerStackFrame(stackDepthLevel)
          : void 0,
      });
    },
    getCallerStackFrame(stackDepthLevel, error = new Error()) {
      const frames = buildStackTrace(error, (line) => parseStackLine(line));
      if (frames.length === 0) {
        return {};
      }
      const autoIndex = findFirstExternalFrameIndex(frames, callerIgnorePatterns);
      const useManualIndex = Number.isFinite(stackDepthLevel) && stackDepthLevel >= 0;
      const resolvedIndex = useManualIndex
        ? clampIndex(stackDepthLevel, frames.length)
        : clampIndex(autoIndex, frames.length);
      return frames[resolvedIndex] ?? {};
    },
    getErrorTrace(error) {
      return buildStackTrace(error, (line) => parseStackLine(line));
    },
    isError(value) {
      return isNativeError(value);
    },
    isBuffer(value) {
      return typeof Buffer !== "undefined" && typeof Buffer.isBuffer === "function"
        ? Buffer.isBuffer(value)
        : false;
    },
    prettyFormatLogObj(maskedArgs, settings) {
      return maskedArgs.reduce(
        (result, arg) => {
          if (environment.isError(arg)) {
            result.errors.push(environment.prettyFormatErrorObj(arg, settings));
          } else {
            result.args.push(arg);
          }
          return result;
        },
        { args: [], errors: [] },
      );
    },
    prettyFormatErrorObj(error, settings) {
      const stackLines = formatStackFrames(environment.getErrorTrace(error), settings);
      const causeSections = collectErrorCauses(error).map((cause, index) => {
        const header = `Caused by (${index + 1}): ${cause.name ?? "Error"}${cause.message ? `: ${cause.message}` : ""}`;
        const frames = formatStackFrames(
          buildStackTrace(cause, (line) => parseStackLine(line)),
          settings,
        );
        return [header, ...frames].join("\n");
      });
      const placeholderValuesError = {
        errorName: ` ${error.name} `,
        errorMessage: formatErrorMessage(error),
        errorStack: [...stackLines, ...causeSections].join("\n"),
      };
      return formatTemplate(settings, settings.prettyErrorTemplate, placeholderValuesError);
    },
    transportFormatted(logMetaMarkup, logArgs, logErrors, logMeta, settings) {
      const prettyLogs = settings.stylePrettyLogs !== false;
      const logErrorsStr =
        (logErrors.length > 0 && logArgs.length > 0 ? "\n" : "") + logErrors.join("\n");
      const sanitizedMetaMarkup = stripAnsi2(logMetaMarkup);
      const metaMarkupForText = prettyLogs ? logMetaMarkup : sanitizedMetaMarkup;
      if (shouldUseCss(prettyLogs)) {
        settings.prettyInspectOptions.colors = false;
        const formattedArgs2 = formatWithOptionsSafe(settings.prettyInspectOptions, logArgs);
        const cssMeta =
          logMeta != null
            ? buildCssMetaOutput(settings, logMeta)
            : { text: sanitizedMetaMarkup, styles: [] };
        const hasCssMeta = cssMeta.text.length > 0 && cssMeta.styles.length > 0;
        const metaOutput = hasCssMeta ? cssMeta.text : sanitizedMetaMarkup;
        const output = metaOutput + formattedArgs2 + logErrorsStr;
        if (hasCssMeta) {
          console.log(output, ...cssMeta.styles);
        } else {
          console.log(output);
        }
        return;
      }
      settings.prettyInspectOptions.colors = prettyLogs;
      const formattedArgs = formatWithOptionsSafe(settings.prettyInspectOptions, logArgs);
      console.log(metaMarkupForText + formattedArgs + logErrorsStr);
    },
    transportJSON(json) {
      console.log(jsonStringifyRecursive(json));
    },
  };
  if (getNodeEnv() === "test") {
    environment.__resetWorkingDirectoryCacheForTests = () => {
      cachedCwd = void 0;
    };
  }
  return environment;
  function parseStackLine(line) {
    return usesBrowserStack ? parseBrowserStackLine(line) : parseServerStackLine(line);
  }
  function parseServerStackLine(rawLine) {
    if (typeof rawLine !== "string" || rawLine.length === 0) {
      return void 0;
    }
    const trimmedLine = rawLine.trim();
    if (!trimmedLine.includes(" at ") && !trimmedLine.startsWith("at ")) {
      return void 0;
    }
    const line = trimmedLine.replace(/^at\s+/, "");
    let method;
    let location = line;
    const methodMatch = line.match(/^(.*?)\s+\((.*)\)$/);
    if (methodMatch) {
      method = methodMatch[1];
      location = methodMatch[2];
    }
    const sanitizedLocation = location.replace(/^\(/, "").replace(/\)$/, "");
    const withoutQuery = sanitizedLocation.replace(/\?.*$/, "");
    let fileLine;
    let fileColumn;
    let filePathCandidate = withoutQuery;
    const segments = withoutQuery.split(":");
    if (segments.length >= 3 && /^\d+$/.test(segments[segments.length - 1] ?? "")) {
      fileColumn = segments.pop();
      fileLine = segments.pop();
      filePathCandidate = segments.join(":");
    } else if (segments.length >= 2 && /^\d+$/.test(segments[segments.length - 1] ?? "")) {
      fileLine = segments.pop();
      filePathCandidate = segments.join(":");
    }
    let normalizedPath = filePathCandidate.replace(/^file:\/\//, "");
    const cwd = getWorkingDirectory();
    if (cwd != null && normalizedPath.startsWith(cwd)) {
      normalizedPath = normalizedPath.slice(cwd.length);
      normalizedPath = normalizedPath.replace(/^[\\/]/, "");
    }
    if (normalizedPath.length === 0) {
      normalizedPath = filePathCandidate;
    }
    const normalizedPathWithoutLine = normalizeFilePath(normalizedPath);
    const effectivePath =
      normalizedPathWithoutLine.length > 0 ? normalizedPathWithoutLine : normalizedPath;
    const pathSegments = effectivePath.split(/\\|\//);
    const fileName = pathSegments[pathSegments.length - 1];
    const fileNameWithLine = fileName && fileLine ? `${fileName}:${fileLine}` : void 0;
    const filePathWithLine = effectivePath && fileLine ? `${effectivePath}:${fileLine}` : void 0;
    return {
      fullFilePath: sanitizedLocation,
      fileName,
      fileNameWithLine,
      fileColumn,
      fileLine,
      filePath: effectivePath,
      filePathWithLine,
      method,
    };
  }
  function parseBrowserStackLine(line) {
    const href = globalThis.location?.origin;
    if (line == null) {
      return void 0;
    }
    const match = line.match(BROWSER_PATH_REGEX);
    if (!match) {
      return void 0;
    }
    const filePath = match[1]?.replace(/\?.*$/, "");
    if (filePath == null) {
      return void 0;
    }
    const pathParts = filePath.split("/");
    const fileLine = match[2];
    const fileColumn = match[3];
    const fileName = pathParts[pathParts.length - 1];
    return {
      fullFilePath: href ? `${href}${filePath}` : filePath,
      fileName,
      fileNameWithLine: fileName && fileLine ? `${fileName}:${fileLine}` : void 0,
      fileColumn,
      fileLine,
      filePath,
      filePathWithLine: fileLine ? `${filePath}:${fileLine}` : void 0,
      method: void 0,
    };
  }
  function formatStackFrames(frames, settings) {
    return frames.map((stackFrame) =>
      formatTemplate(settings, settings.prettyErrorStackTemplate, { ...stackFrame }, true),
    );
  }
  function formatErrorMessage(error) {
    return Object.getOwnPropertyNames(error)
      .filter((key) => key !== "stack" && key !== "cause")
      .reduce((result, key) => {
        const value = error[key];
        if (typeof value === "function") {
          return result;
        }
        result.push(String(value));
        return result;
      }, [])
      .join(", ");
  }
  function shouldUseCss(prettyLogs) {
    return (
      prettyLogs &&
      (runtimeInfo.name === "browser" || runtimeInfo.name === "worker") &&
      consoleSupportsCssStyling()
    );
  }
  function stripAnsi2(value) {
    return value.replace(ANSI_REGEX, "");
  }
  function buildCssMetaOutput(settings, metaValue) {
    if (metaValue == null) {
      return { text: "", styles: [] };
    }
    const { template, placeholders } = buildPrettyMeta(settings, metaValue);
    const parts = [];
    const styles3 = [];
    let lastIndex = 0;
    const placeholderRegex = /{{(.+?)}}/g;
    let match;
    while ((match = placeholderRegex.exec(template)) != null) {
      if (match.index > lastIndex) {
        parts.push(template.slice(lastIndex, match.index));
      }
      const key = match[1];
      const rawValue = placeholders[key] != null ? String(placeholders[key]) : "";
      const tokens = collectStyleTokens(settings.prettyLogStyles?.[key], rawValue);
      const css = tokensToCss(tokens);
      if (css.length > 0) {
        parts.push(`%c${rawValue}%c`);
        styles3.push(css, "");
      } else {
        parts.push(rawValue);
      }
      lastIndex = placeholderRegex.lastIndex;
    }
    if (lastIndex < template.length) {
      parts.push(template.slice(lastIndex));
    }
    return {
      text: parts.join(""),
      styles: styles3,
    };
  }
  function collectStyleTokens(style, value) {
    if (style == null) {
      return [];
    }
    if (typeof style === "string") {
      return [style];
    }
    if (Array.isArray(style)) {
      return style.flatMap((token) => collectStyleTokens(token, value));
    }
    if (typeof style === "object") {
      const normalizedValue = value.trim();
      const nextStyle = style[normalizedValue] ?? style["*"];
      if (nextStyle == null) {
        return [];
      }
      return collectStyleTokens(nextStyle, value);
    }
    return [];
  }
  function tokensToCss(tokens) {
    const seen = /* @__PURE__ */ new Set();
    const cssParts = [];
    for (const token of tokens) {
      const css = styleTokenToCss(token);
      if (css != null && css.length > 0 && !seen.has(css)) {
        seen.add(css);
        cssParts.push(css);
      }
    }
    return cssParts.join("; ");
  }
  function styleTokenToCss(token) {
    const color = COLOR_TOKENS[token];
    if (color != null) {
      return `color: ${color}`;
    }
    const background = BACKGROUND_TOKENS[token];
    if (background != null) {
      return `background-color: ${background}`;
    }
    switch (token) {
      case "bold":
        return "font-weight: bold";
      case "dim":
        return "opacity: 0.75";
      case "italic":
        return "font-style: italic";
      case "underline":
        return "text-decoration: underline";
      case "overline":
        return "text-decoration: overline";
      case "inverse":
        return "filter: invert(1)";
      case "hidden":
        return "visibility: hidden";
      case "strikethrough":
        return "text-decoration: line-through";
      default:
        return void 0;
    }
  }
  function getWorkingDirectory() {
    if (cachedCwd === void 0) {
      cachedCwd = safeGetCwd() ?? null;
    }
    return cachedCwd ?? void 0;
  }
  function shouldCaptureHostname() {
    return runtimeInfo.name === "node" || runtimeInfo.name === "deno" || runtimeInfo.name === "bun";
  }
  function shouldCaptureRuntimeVersion() {
    return runtimeInfo.name === "node" || runtimeInfo.name === "deno" || runtimeInfo.name === "bun";
  }
  function createRuntimeMeta(info2) {
    if (info2.name === "browser" || info2.name === "worker") {
      return {
        runtime: info2.name,
        browser: info2.userAgent,
      };
    }
    const metaStatic = {
      runtime: info2.name,
    };
    if (shouldCaptureRuntimeVersion()) {
      metaStatic.runtimeVersion = info2.version ?? "unknown";
    }
    if (shouldCaptureHostname()) {
      metaStatic.hostname = info2.hostname ?? "unknown";
    }
    return metaStatic;
  }
  function formatWithOptionsSafe(options, args) {
    try {
      return formatWithOptions(options, ...args);
    } catch {
      return args.map(stringifyFallback).join(" ");
    }
  }
  function stringifyFallback(value) {
    if (typeof value === "string") {
      return value;
    }
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }
  function normalizeFilePath(value) {
    if (typeof value !== "string" || value.length === 0) {
      return value;
    }
    const replaced = value.replace(/\\+/g, "\\").replace(/\\/g, "/");
    const hasRootDoubleSlash = replaced.startsWith("//");
    const hasLeadingSlash = replaced.startsWith("/") && !hasRootDoubleSlash;
    const driveMatch = replaced.match(/^[A-Za-z]:/);
    const drivePrefix = driveMatch ? driveMatch[0] : "";
    const withoutDrive = drivePrefix ? replaced.slice(drivePrefix.length) : replaced;
    const segments = withoutDrive.split("/");
    const normalizedSegments = [];
    for (const segment of segments) {
      if (segment === "" || segment === ".") {
        continue;
      }
      if (segment === "..") {
        if (normalizedSegments.length > 0) {
          normalizedSegments.pop();
        }
        continue;
      }
      normalizedSegments.push(segment);
    }
    let normalized = normalizedSegments.join("/");
    if (hasRootDoubleSlash) {
      normalized = `//${normalized}`;
    } else if (hasLeadingSlash) {
      normalized = `/${normalized}`;
    } else if (drivePrefix !== "") {
      normalized = `${drivePrefix}${normalized.length > 0 ? `/${normalized}` : ""}`;
    }
    if (normalized.length === 0) {
      return value;
    }
    return normalized;
  }
  function detectRuntimeInfo() {
    if (isBrowserEnvironment()) {
      const navigatorObj = globalThis.navigator;
      return {
        name: "browser",
        userAgent: navigatorObj?.userAgent,
      };
    }
    const globalScope = globalThis;
    if (typeof globalScope.importScripts === "function") {
      return {
        name: "worker",
        userAgent: globalScope.navigator?.userAgent,
      };
    }
    const globalAny = globalThis;
    if (globalAny.Bun != null) {
      const bunVersion = globalAny.Bun.version;
      return {
        name: "bun",
        version: bunVersion != null ? `bun/${bunVersion}` : void 0,
        hostname: getEnvironmentHostname(
          globalAny.process,
          globalAny.Deno,
          globalAny.Bun,
          globalAny.location,
        ),
      };
    }
    if (globalAny.Deno != null) {
      const denoHostname = resolveDenoHostname(globalAny.Deno);
      const denoVersion = globalAny.Deno?.version?.deno;
      return {
        name: "deno",
        version: denoVersion != null ? `deno/${denoVersion}` : void 0,
        hostname:
          denoHostname ??
          getEnvironmentHostname(
            globalAny.process,
            globalAny.Deno,
            globalAny.Bun,
            globalAny.location,
          ),
      };
    }
    if (globalAny.process?.versions?.node != null || globalAny.process?.version != null) {
      return {
        name: "node",
        version: globalAny.process?.versions?.node ?? globalAny.process?.version,
        hostname: getEnvironmentHostname(
          globalAny.process,
          globalAny.Deno,
          globalAny.Bun,
          globalAny.location,
        ),
      };
    }
    if (globalAny.process != null) {
      return {
        name: "node",
        version: "unknown",
        hostname: getEnvironmentHostname(
          globalAny.process,
          globalAny.Deno,
          globalAny.Bun,
          globalAny.location,
        ),
      };
    }
    return {
      name: "unknown",
    };
  }
  function getEnvironmentHostname(nodeProcess, deno, bun, location) {
    const processHostname =
      nodeProcess?.env?.HOSTNAME ?? nodeProcess?.env?.HOST ?? nodeProcess?.env?.COMPUTERNAME;
    if (processHostname != null && processHostname.length > 0) {
      return processHostname;
    }
    const bunHostname = bun?.env?.HOSTNAME ?? bun?.env?.HOST ?? bun?.env?.COMPUTERNAME;
    if (bunHostname != null && bunHostname.length > 0) {
      return bunHostname;
    }
    try {
      const denoEnvGet = deno?.env?.get;
      if (typeof denoEnvGet === "function") {
        const value = denoEnvGet("HOSTNAME");
        if (value != null && value.length > 0) {
          return value;
        }
      }
    } catch {}
    if (location?.hostname != null && location.hostname.length > 0) {
      return location.hostname;
    }
    return void 0;
  }
  function resolveDenoHostname(deno) {
    try {
      if (typeof deno?.hostname === "function") {
        const value = deno.hostname();
        if (value != null && value.length > 0) {
          return value;
        }
      }
    } catch {}
    const locationHostname = globalThis.location?.hostname;
    if (locationHostname != null && locationHostname.length > 0) {
      return locationHostname;
    }
    return void 0;
  }
  function getNodeEnv() {
    const globalProcess = globalThis?.process;
    return globalProcess?.env?.NODE_ENV;
  }
  function isNativeError(value) {
    if (value instanceof Error) {
      return true;
    }
    if (value != null && typeof value === "object") {
      const objectTag = Object.prototype.toString.call(value);
      if (/\[object .*Error\]/.test(objectTag)) {
        return true;
      }
      const name = value.name;
      if (typeof name === "string" && name.endsWith("Error")) {
        return true;
      }
    }
    return false;
  }
}
var ANSI_REGEX = /\u001b\[[0-9;]*m/g;
var COLOR_TOKENS = {
  black: "#000000",
  red: "#ef5350",
  green: "#66bb6a",
  yellow: "#fdd835",
  blue: "#42a5f5",
  magenta: "#ab47bc",
  cyan: "#26c6da",
  white: "#fafafa",
  blackBright: "#424242",
  redBright: "#ff7043",
  greenBright: "#81c784",
  yellowBright: "#ffe082",
  blueBright: "#64b5f6",
  magentaBright: "#ce93d8",
  cyanBright: "#4dd0e1",
  whiteBright: "#ffffff",
};
var BACKGROUND_TOKENS = {
  bgBlack: "#000000",
  bgRed: "#ef5350",
  bgGreen: "#66bb6a",
  bgYellow: "#fdd835",
  bgBlue: "#42a5f5",
  bgMagenta: "#ab47bc",
  bgCyan: "#26c6da",
  bgWhite: "#fafafa",
  bgBlackBright: "#424242",
  bgRedBright: "#ff7043",
  bgGreenBright: "#81c784",
  bgYellowBright: "#ffe082",
  bgBlueBright: "#64b5f6",
  bgMagentaBright: "#ce93d8",
  bgCyanBright: "#4dd0e1",
  bgWhiteBright: "#ffffff",
};
var BROWSER_PATH_REGEX =
  /(?:(?:file|https?|global code|[^@]+)@)?(?:file:)?((?:\/[^:/]+){2,})(?::(\d+))?(?::(\d+))?/;
var runtime = createLoggerEnvironment();
var BaseLogger = class {
  constructor(settings, logObj, stackDepthLevel = Number.NaN) {
    this.logObj = logObj;
    this.stackDepthLevel = stackDepthLevel;
    this.runtime = runtime;
    this.maxErrorCauseDepth = 5;
    this.settings = {
      type: settings?.type ?? "pretty",
      name: settings?.name,
      parentNames: settings?.parentNames,
      minLevel: settings?.minLevel ?? 0,
      argumentsArrayName: settings?.argumentsArrayName,
      hideLogPositionForProduction: settings?.hideLogPositionForProduction ?? false,
      prettyLogTemplate:
        settings?.prettyLogTemplate ??
        "{{yyyy}}.{{mm}}.{{dd}} {{hh}}:{{MM}}:{{ss}}:{{ms}}	{{logLevelName}}	{{filePathWithLine}}{{nameWithDelimiterPrefix}}	",
      prettyErrorTemplate:
        settings?.prettyErrorTemplate ??
        "\n{{errorName}} {{errorMessage}}\nerror stack:\n{{errorStack}}",
      prettyErrorStackTemplate:
        settings?.prettyErrorStackTemplate ??
        "  \u2022 {{fileName}}	{{method}}\n	{{filePathWithLine}}",
      prettyErrorParentNamesSeparator: settings?.prettyErrorParentNamesSeparator ?? ":",
      prettyErrorLoggerNameDelimiter: settings?.prettyErrorLoggerNameDelimiter ?? "	",
      stylePrettyLogs: settings?.stylePrettyLogs ?? true,
      prettyLogTimeZone: settings?.prettyLogTimeZone ?? "UTC",
      prettyLogStyles: settings?.prettyLogStyles ?? {
        logLevelName: {
          "*": ["bold", "black", "bgWhiteBright", "dim"],
          SILLY: ["bold", "white"],
          TRACE: ["bold", "whiteBright"],
          DEBUG: ["bold", "green"],
          INFO: ["bold", "blue"],
          WARN: ["bold", "yellow"],
          ERROR: ["bold", "red"],
          FATAL: ["bold", "redBright"],
        },
        dateIsoStr: "white",
        filePathWithLine: "white",
        name: ["white", "bold"],
        nameWithDelimiterPrefix: ["white", "bold"],
        nameWithDelimiterSuffix: ["white", "bold"],
        errorName: ["bold", "bgRedBright", "whiteBright"],
        fileName: ["yellow"],
        fileNameWithLine: "white",
      },
      prettyInspectOptions: settings?.prettyInspectOptions ?? {
        colors: true,
        compact: false,
        depth: Infinity,
      },
      metaProperty: settings?.metaProperty ?? "_meta",
      maskPlaceholder: settings?.maskPlaceholder ?? "[***]",
      maskValuesOfKeys: settings?.maskValuesOfKeys ?? ["password"],
      maskValuesOfKeysCaseInsensitive: settings?.maskValuesOfKeysCaseInsensitive ?? false,
      maskValuesRegEx: settings?.maskValuesRegEx,
      prefix: [...(settings?.prefix ?? [])],
      attachedTransports: [...(settings?.attachedTransports ?? [])],
      overwrite: {
        mask: settings?.overwrite?.mask,
        toLogObj: settings?.overwrite?.toLogObj,
        addMeta: settings?.overwrite?.addMeta,
        addPlaceholders: settings?.overwrite?.addPlaceholders,
        formatMeta: settings?.overwrite?.formatMeta,
        formatLogObj: settings?.overwrite?.formatLogObj,
        transportFormatted: settings?.overwrite?.transportFormatted,
        transportJSON: settings?.overwrite?.transportJSON,
      },
    };
    this.captureStackForMeta = this._shouldCaptureStack();
  }
  log(logLevelId, logLevelName, ...args) {
    if (logLevelId < this.settings.minLevel) {
      return;
    }
    const resolvedArgs = this._resolveLogArguments(args);
    const logArgs = [...this.settings.prefix, ...resolvedArgs];
    const maskedArgs =
      this.settings.overwrite?.mask != null
        ? this.settings.overwrite?.mask(logArgs)
        : this.settings.maskValuesOfKeys != null && this.settings.maskValuesOfKeys.length > 0
          ? this._mask(logArgs)
          : logArgs;
    const thisLogObj =
      this.logObj != null ? this._recursiveCloneAndExecuteFunctions(this.logObj) : void 0;
    const logObj =
      this.settings.overwrite?.toLogObj != null
        ? this.settings.overwrite?.toLogObj(maskedArgs, thisLogObj)
        : this._toLogObj(maskedArgs, thisLogObj);
    const logObjWithMeta =
      this.settings.overwrite?.addMeta != null
        ? this.settings.overwrite?.addMeta(logObj, logLevelId, logLevelName)
        : this._addMetaToLogObj(logObj, logLevelId, logLevelName);
    const logMeta = logObjWithMeta?.[this.settings.metaProperty];
    let logMetaMarkup;
    let logArgsAndErrorsMarkup = void 0;
    if (this.settings.overwrite?.formatMeta != null) {
      logMetaMarkup = this.settings.overwrite?.formatMeta(
        logObjWithMeta?.[this.settings.metaProperty],
      );
    }
    if (this.settings.overwrite?.formatLogObj != null) {
      logArgsAndErrorsMarkup = this.settings.overwrite?.formatLogObj(maskedArgs, this.settings);
    }
    if (this.settings.type === "pretty") {
      logMetaMarkup =
        logMetaMarkup ?? this._prettyFormatLogObjMeta(logObjWithMeta?.[this.settings.metaProperty]);
      logArgsAndErrorsMarkup =
        logArgsAndErrorsMarkup ?? runtime.prettyFormatLogObj(maskedArgs, this.settings);
    }
    if (logMetaMarkup != null && logArgsAndErrorsMarkup != null) {
      if (this.settings.overwrite?.transportFormatted != null) {
        const transport = this.settings.overwrite.transportFormatted;
        const declaredParams = transport.length;
        if (declaredParams < 4) {
          transport(logMetaMarkup, logArgsAndErrorsMarkup.args, logArgsAndErrorsMarkup.errors);
        } else if (declaredParams === 4) {
          transport(
            logMetaMarkup,
            logArgsAndErrorsMarkup.args,
            logArgsAndErrorsMarkup.errors,
            logMeta,
          );
        } else {
          transport(
            logMetaMarkup,
            logArgsAndErrorsMarkup.args,
            logArgsAndErrorsMarkup.errors,
            logMeta,
            this.settings,
          );
        }
      } else {
        runtime.transportFormatted(
          logMetaMarkup,
          logArgsAndErrorsMarkup.args,
          logArgsAndErrorsMarkup.errors,
          logMeta,
          this.settings,
        );
      }
    } else {
      if (this.settings.overwrite?.transportJSON != null) {
        this.settings.overwrite.transportJSON(logObjWithMeta);
      } else if (this.settings.type !== "hidden") {
        runtime.transportJSON(logObjWithMeta);
      }
    }
    if (this.settings.attachedTransports != null && this.settings.attachedTransports.length > 0) {
      this.settings.attachedTransports.forEach((transportLogger) => {
        transportLogger(logObjWithMeta);
      });
    }
    return logObjWithMeta;
  }
  attachTransport(transportLogger) {
    this.settings.attachedTransports.push(transportLogger);
  }
  getSubLogger(settings, logObj) {
    const subLoggerSettings = {
      ...this.settings,
      ...settings,
      parentNames:
        this.settings?.parentNames != null && this.settings?.name != null
          ? [...this.settings.parentNames, this.settings.name]
          : this.settings?.name != null
            ? [this.settings.name]
            : void 0,
      prefix: [...this.settings.prefix, ...(settings?.prefix ?? [])],
    };
    const subLogger = new this.constructor(
      subLoggerSettings,
      logObj ?? this.logObj,
      this.stackDepthLevel,
    );
    return subLogger;
  }
  _mask(args) {
    const maskKeys = this._getMaskKeys();
    return args?.map((arg) => {
      return this._recursiveCloneAndMaskValuesOfKeys(arg, maskKeys);
    });
  }
  _getMaskKeys() {
    const maskKeys = this.settings.maskValuesOfKeys ?? [];
    const signature = maskKeys.map(String).join("|");
    if (this.settings.maskValuesOfKeysCaseInsensitive === true) {
      if (
        this.maskKeysCache?.source === maskKeys &&
        this.maskKeysCache.caseInsensitive === true &&
        this.maskKeysCache.signature === signature
      ) {
        return this.maskKeysCache.normalized;
      }
      const normalized = maskKeys.map((key) =>
        typeof key === "string" ? key.toLowerCase() : String(key).toLowerCase(),
      );
      this.maskKeysCache = {
        source: maskKeys,
        caseInsensitive: true,
        normalized,
        signature,
      };
      return normalized;
    }
    this.maskKeysCache = {
      source: maskKeys,
      caseInsensitive: false,
      normalized: maskKeys,
      signature,
    };
    return maskKeys;
  }
  _resolveLogArguments(args) {
    if (args.length === 1 && typeof args[0] === "function") {
      const candidate = args[0];
      if (candidate.length === 0) {
        const result = candidate();
        return Array.isArray(result) ? result : [result];
      }
    }
    return args;
  }
  _recursiveCloneAndMaskValuesOfKeys(source, keys, seen = []) {
    if (seen.includes(source)) {
      return { ...source };
    }
    if (typeof source === "object" && source !== null) {
      seen.push(source);
    }
    if (runtime.isError(source) || runtime.isBuffer(source)) {
      return source;
    } else if (source instanceof Map) {
      return new Map(source);
    } else if (source instanceof Set) {
      return new Set(source);
    } else if (Array.isArray(source)) {
      return source.map((item) => this._recursiveCloneAndMaskValuesOfKeys(item, keys, seen));
    } else if (source instanceof Date) {
      return new Date(source.getTime());
    } else if (source instanceof URL) {
      return urlToObject(source);
    } else if (source !== null && typeof source === "object") {
      const baseObject = runtime.isError(source)
        ? this._cloneError(source)
        : Object.create(Object.getPrototypeOf(source));
      return Object.getOwnPropertyNames(source).reduce((o, prop) => {
        const lookupKey =
          this.settings?.maskValuesOfKeysCaseInsensitive !== true
            ? prop
            : typeof prop === "string"
              ? prop.toLowerCase()
              : String(prop).toLowerCase();
        o[prop] = keys.includes(lookupKey)
          ? this.settings.maskPlaceholder
          : (() => {
              try {
                return this._recursiveCloneAndMaskValuesOfKeys(source[prop], keys, seen);
              } catch {
                return null;
              }
            })();
        return o;
      }, baseObject);
    } else {
      if (typeof source === "string") {
        let modifiedSource = source;
        for (const regEx of this.settings?.maskValuesRegEx || []) {
          modifiedSource = modifiedSource.replace(regEx, this.settings?.maskPlaceholder || "");
        }
        return modifiedSource;
      }
      return source;
    }
  }
  _recursiveCloneAndExecuteFunctions(source, seen = []) {
    if (this.isObjectOrArray(source) && seen.includes(source)) {
      return this.shallowCopy(source);
    }
    if (this.isObjectOrArray(source)) {
      seen.push(source);
    }
    if (Array.isArray(source)) {
      return source.map((item) => this._recursiveCloneAndExecuteFunctions(item, seen));
    } else if (source instanceof Date) {
      return new Date(source.getTime());
    } else if (this.isObject(source)) {
      return Object.getOwnPropertyNames(source).reduce(
        (o, prop) => {
          const descriptor = Object.getOwnPropertyDescriptor(source, prop);
          if (descriptor) {
            Object.defineProperty(o, prop, descriptor);
            const value = source[prop];
            o[prop] =
              typeof value === "function"
                ? value()
                : this._recursiveCloneAndExecuteFunctions(value, seen);
          }
          return o;
        },
        Object.create(Object.getPrototypeOf(source)),
      );
    } else {
      return source;
    }
  }
  isObjectOrArray(value) {
    return typeof value === "object" && value !== null;
  }
  isObject(value) {
    return typeof value === "object" && !Array.isArray(value) && value !== null;
  }
  shallowCopy(source) {
    if (Array.isArray(source)) {
      return [...source];
    } else {
      return { ...source };
    }
  }
  _toLogObj(args, clonedLogObj = {}) {
    args = args?.map((arg) => (runtime.isError(arg) ? this._toErrorObject(arg) : arg));
    if (this.settings.argumentsArrayName == null) {
      if (
        args.length === 1 &&
        !Array.isArray(args[0]) &&
        runtime.isBuffer(args[0]) !== true &&
        !(args[0] instanceof Date)
      ) {
        clonedLogObj =
          typeof args[0] === "object" && args[0] != null
            ? { ...args[0], ...clonedLogObj }
            : { 0: args[0], ...clonedLogObj };
      } else {
        clonedLogObj = { ...clonedLogObj, ...args };
      }
    } else {
      clonedLogObj = {
        ...clonedLogObj,
        [this.settings.argumentsArrayName]: args,
      };
    }
    return clonedLogObj;
  }
  _cloneError(error) {
    const cloned = new error.constructor();
    Object.getOwnPropertyNames(error).forEach((key) => {
      cloned[key] = error[key];
    });
    return cloned;
  }
  _toErrorObject(error, depth = 0, seen = /* @__PURE__ */ new Set()) {
    if (!seen.has(error)) {
      seen.add(error);
    }
    const errorObject = {
      nativeError: error,
      name: error.name ?? "Error",
      message: error.message,
      stack: runtime.getErrorTrace(error),
    };
    if (depth >= this.maxErrorCauseDepth) {
      return errorObject;
    }
    const causeValue = error.cause;
    if (causeValue != null) {
      const normalizedCause = toError(causeValue);
      if (!seen.has(normalizedCause)) {
        errorObject.cause = this._toErrorObject(normalizedCause, depth + 1, seen);
      }
    }
    return errorObject;
  }
  _addMetaToLogObj(logObj, logLevelId, logLevelName) {
    return {
      ...logObj,
      [this.settings.metaProperty]: runtime.getMeta(
        logLevelId,
        logLevelName,
        this.stackDepthLevel,
        !this.captureStackForMeta,
        this.settings.name,
        this.settings.parentNames,
      ),
    };
  }
  _shouldCaptureStack() {
    if (this.settings.hideLogPositionForProduction) {
      return false;
    }
    if (this.settings.type === "json") {
      return true;
    }
    const template = this.settings.prettyLogTemplate ?? "";
    const stackPlaceholders =
      /{{\s*(file(Name|Path|Line|PathWithLine|NameWithLine)|fullFilePath)\s*}}/;
    if (stackPlaceholders.test(template)) {
      return true;
    }
    return false;
  }
  _prettyFormatLogObjMeta(logObjMeta) {
    return buildPrettyMeta(this.settings, logObjMeta).text;
  }
};

// node_modules/.pnpm/tslog@4.10.2/node_modules/tslog/esm/index.js
var Logger = class extends BaseLogger {
  constructor(settings, logObj) {
    const isBrowser = typeof window !== "undefined" && typeof document !== "undefined";
    const normalizedSettings = { ...(settings ?? {}) };
    if (isBrowser) {
      normalizedSettings.stylePrettyLogs = settings?.stylePrettyLogs ?? true;
    }
    super(normalizedSettings, logObj, Number.NaN);
  }
  log(logLevelId, logLevelName, ...args) {
    return super.log(logLevelId, logLevelName, ...args);
  }
  silly(...args) {
    return super.log(0, "SILLY", ...args);
  }
  trace(...args) {
    return super.log(1, "TRACE", ...args);
  }
  debug(...args) {
    return super.log(2, "DEBUG", ...args);
  }
  info(...args) {
    return super.log(3, "INFO", ...args);
  }
  warn(...args) {
    return super.log(4, "WARN", ...args);
  }
  error(...args) {
    return super.log(5, "ERROR", ...args);
  }
  fatal(...args) {
    return super.log(6, "FATAL", ...args);
  }
  getSubLogger(settings, logObj) {
    return super.getSubLogger(settings, logObj);
  }
};

// src/infra/tmp-bitterbot-dir.ts
import fs2 from "node:fs";
import os4 from "node:os";
import path3 from "node:path";
var POSIX_BITTERBOT_TMP_DIR = "/tmp/bitterbot";
function isNodeErrorWithCode(err2, code) {
  return typeof err2 === "object" && err2 !== null && "code" in err2 && err2.code === code;
}
function resolvePreferredBitterbotTmpDir(options = {}) {
  const accessSync = options.accessSync ?? fs2.accessSync;
  const lstatSync = options.lstatSync ?? fs2.lstatSync;
  const mkdirSync = options.mkdirSync ?? fs2.mkdirSync;
  const getuid =
    options.getuid ??
    (() => {
      try {
        return typeof process.getuid === "function" ? process.getuid() : void 0;
      } catch {
        return void 0;
      }
    });
  const tmpdir = options.tmpdir ?? os4.tmpdir;
  const uid = getuid();
  const isSecureDirForUser = (st) => {
    if (uid === void 0) {
      return true;
    }
    if (typeof st.uid === "number" && st.uid !== uid) {
      return false;
    }
    if (typeof st.mode === "number" && (st.mode & 18) !== 0) {
      return false;
    }
    return true;
  };
  const fallback = () => {
    const base = tmpdir();
    const suffix = uid === void 0 ? "bitterbot" : `bitterbot-${uid}`;
    return path3.join(base, suffix);
  };
  try {
    const preferred = lstatSync(POSIX_BITTERBOT_TMP_DIR);
    if (!preferred.isDirectory() || preferred.isSymbolicLink()) {
      return fallback();
    }
    accessSync(POSIX_BITTERBOT_TMP_DIR, fs2.constants.W_OK | fs2.constants.X_OK);
    if (!isSecureDirForUser(preferred)) {
      return fallback();
    }
    return POSIX_BITTERBOT_TMP_DIR;
  } catch (err2) {
    if (!isNodeErrorWithCode(err2, "ENOENT")) {
      return fallback();
    }
  }
  try {
    accessSync("/tmp", fs2.constants.W_OK | fs2.constants.X_OK);
    mkdirSync(POSIX_BITTERBOT_TMP_DIR, { recursive: true, mode: 448 });
    try {
      const preferred = lstatSync(POSIX_BITTERBOT_TMP_DIR);
      if (!preferred.isDirectory() || preferred.isSymbolicLink()) {
        return fallback();
      }
      if (!isSecureDirForUser(preferred)) {
        return fallback();
      }
    } catch {
      return fallback();
    }
    return POSIX_BITTERBOT_TMP_DIR;
  } catch {
    return fallback();
  }
}

// src/logging/config.ts
var import_json5 = __toESM(require_lib(), 1);
import fs3 from "node:fs";
function readLoggingConfig() {
  const configPath = resolveConfigPath();
  try {
    if (!fs3.existsSync(configPath)) {
      return void 0;
    }
    const raw = fs3.readFileSync(configPath, "utf-8");
    const parsed = import_json5.default.parse(raw);
    const logging = parsed?.logging;
    if (!logging || typeof logging !== "object" || Array.isArray(logging)) {
      return void 0;
    }
    return logging;
  } catch {
    return void 0;
  }
}

// src/logging/levels.ts
var ALLOWED_LOG_LEVELS = ["silent", "fatal", "error", "warn", "info", "debug", "trace"];
function normalizeLogLevel(level, fallback = "info") {
  const candidate = (level ?? fallback).trim();
  return ALLOWED_LOG_LEVELS.includes(candidate) ? candidate : fallback;
}
function levelToMinLevel(level) {
  const map = {
    fatal: 0,
    error: 1,
    warn: 2,
    info: 3,
    debug: 4,
    trace: 5,
    silent: Number.POSITIVE_INFINITY,
  };
  return map[level];
}

// src/logging/state.ts
var loggingState = {
  cachedLogger: null,
  cachedSettings: null,
  cachedConsoleSettings: null,
  overrideSettings: null,
  consolePatched: false,
  forceConsoleToStderr: false,
  consoleTimestampPrefix: false,
  consoleSubsystemFilter: null,
  resolvingConsoleSettings: false,
  streamErrorHandlersInstalled: false,
  rawConsole: null,
};

// src/logging/logger.ts
var DEFAULT_LOG_DIR = resolvePreferredBitterbotTmpDir();
var DEFAULT_LOG_FILE = path4.join(DEFAULT_LOG_DIR, "bitterbot.log");
var LOG_PREFIX = "bitterbot";
var LOG_SUFFIX = ".log";
var MAX_LOG_AGE_MS = 24 * 60 * 60 * 1e3;
var requireConfig = createRequire(import.meta.url);
var externalTransports = /* @__PURE__ */ new Set();
function attachExternalTransport(logger, transport) {
  logger.attachTransport((logObj) => {
    if (!externalTransports.has(transport)) {
      return;
    }
    try {
      transport(logObj);
    } catch {}
  });
}
function resolveSettings() {
  let cfg = loggingState.overrideSettings ?? readLoggingConfig();
  if (!cfg) {
    try {
      const loaded = requireConfig("../config/config.js");
      cfg = loaded.loadConfig?.().logging;
    } catch {
      cfg = void 0;
    }
  }
  const defaultLevel =
    process.env.VITEST === "true" && process.env.BITTERBOT_TEST_FILE_LOG !== "1"
      ? "silent"
      : "info";
  const level = normalizeLogLevel(cfg?.level, defaultLevel);
  const file = cfg?.file ?? defaultRollingPathForToday();
  return { level, file };
}
function settingsChanged(a, b) {
  if (!a) {
    return true;
  }
  return a.level !== b.level || a.file !== b.file;
}
function isFileLogLevelEnabled(level) {
  const settings = loggingState.cachedSettings ?? resolveSettings();
  if (!loggingState.cachedSettings) {
    loggingState.cachedSettings = settings;
  }
  if (settings.level === "silent") {
    return false;
  }
  return levelToMinLevel(level) <= levelToMinLevel(settings.level);
}
function buildLogger(settings) {
  fs4.mkdirSync(path4.dirname(settings.file), { recursive: true });
  if (isRollingPath(settings.file)) {
    pruneOldRollingLogs(path4.dirname(settings.file));
  }
  const logger = new Logger({
    name: "bitterbot",
    minLevel: levelToMinLevel(settings.level),
    type: "hidden",
    // no ansi formatting
  });
  logger.attachTransport((logObj) => {
    try {
      const time = logObj.date?.toISOString?.() ?? /* @__PURE__ */ new Date().toISOString();
      const line = JSON.stringify({ ...logObj, time });
      fs4.appendFileSync(
        settings.file,
        `${line}
`,
        { encoding: "utf8" },
      );
    } catch {}
  });
  for (const transport of externalTransports) {
    attachExternalTransport(logger, transport);
  }
  return logger;
}
function getLogger() {
  const settings = resolveSettings();
  const cachedLogger = loggingState.cachedLogger;
  const cachedSettings = loggingState.cachedSettings;
  if (!cachedLogger || settingsChanged(cachedSettings, settings)) {
    loggingState.cachedLogger = buildLogger(settings);
    loggingState.cachedSettings = settings;
  }
  return loggingState.cachedLogger;
}
function getChildLogger(bindings, opts) {
  const base = getLogger();
  const minLevel = opts?.level ? levelToMinLevel(opts.level) : void 0;
  const name = bindings ? JSON.stringify(bindings) : void 0;
  return base.getSubLogger({
    name,
    minLevel,
    prefix: bindings ? [name ?? ""] : [],
  });
}
function formatLocalDate(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}
function defaultRollingPathForToday() {
  const today = formatLocalDate(/* @__PURE__ */ new Date());
  return path4.join(DEFAULT_LOG_DIR, `${LOG_PREFIX}-${today}${LOG_SUFFIX}`);
}
function isRollingPath(file) {
  const base = path4.basename(file);
  return (
    base.startsWith(`${LOG_PREFIX}-`) &&
    base.endsWith(LOG_SUFFIX) &&
    base.length === `${LOG_PREFIX}-YYYY-MM-DD${LOG_SUFFIX}`.length
  );
}
function pruneOldRollingLogs(dir) {
  try {
    const entries = fs4.readdirSync(dir, { withFileTypes: true });
    const cutoff = Date.now() - MAX_LOG_AGE_MS;
    for (const entry of entries) {
      if (!entry.isFile()) {
        continue;
      }
      if (!entry.name.startsWith(`${LOG_PREFIX}-`) || !entry.name.endsWith(LOG_SUFFIX)) {
        continue;
      }
      const fullPath = path4.join(dir, entry.name);
      try {
        const stat = fs4.statSync(fullPath);
        if (stat.mtimeMs < cutoff) {
          fs4.rmSync(fullPath, { force: true });
        }
      } catch {}
    }
  } catch {}
}

// src/terminal/palette.ts
var BITTERBOT_PALETTE = {
  accent: "#8b5cf6",
  accentBright: "#a855f7",
  accentDim: "#7c3aed",
  info: "#c084fc",
  success: "#2FBF71",
  warn: "#FFB020",
  error: "#E23D2D",
  muted: "#8B7F77",
};

// src/terminal/theme.ts
var hasForceColor =
  typeof process.env.FORCE_COLOR === "string" &&
  process.env.FORCE_COLOR.trim().length > 0 &&
  process.env.FORCE_COLOR.trim() !== "0";
var baseChalk = process.env.NO_COLOR && !hasForceColor ? new Chalk({ level: 0 }) : source_default;
var hex = (value) => baseChalk.hex(value);
var theme = {
  accent: hex(BITTERBOT_PALETTE.accent),
  accentBright: hex(BITTERBOT_PALETTE.accentBright),
  accentDim: hex(BITTERBOT_PALETTE.accentDim),
  info: hex(BITTERBOT_PALETTE.info),
  success: hex(BITTERBOT_PALETTE.success),
  warn: hex(BITTERBOT_PALETTE.warn),
  error: hex(BITTERBOT_PALETTE.error),
  muted: hex(BITTERBOT_PALETTE.muted),
  heading: baseChalk.bold.hex(BITTERBOT_PALETTE.accent),
  command: hex(BITTERBOT_PALETTE.accentBright),
  option: hex(BITTERBOT_PALETTE.warn),
};

// src/globals.ts
var globalVerbose = false;
function isVerbose() {
  return globalVerbose;
}
var success = theme.success;
var warn = theme.warn;
var info = theme.info;
var danger = theme.error;

// src/utils.ts
function resolveUserPath2(input) {
  const trimmed = input.trim();
  if (!trimmed) {
    return trimmed;
  }
  if (trimmed.startsWith("~")) {
    const expanded = expandHomePrefix(trimmed, {
      home: resolveRequiredHomeDir(process.env, os5.homedir),
      env: process.env,
      homedir: os5.homedir,
    });
    return path5.resolve(expanded);
  }
  return path5.resolve(trimmed);
}
function resolveConfigDir(env2 = process.env, homedir = os5.homedir) {
  const override = env2.BITTERBOT_STATE_DIR?.trim();
  if (override) {
    return resolveUserPath2(override);
  }
  const newDir = path5.join(resolveRequiredHomeDir(env2, homedir), ".bitterbot");
  try {
    const hasNew = fs5.existsSync(newDir);
    if (hasNew) {
      return newDir;
    }
  } catch {}
  return newDir;
}
var CONFIG_DIR = resolveConfigDir();

// src/plugins/registry.ts
function createEmptyPluginRegistry() {
  return {
    plugins: [],
    tools: [],
    hooks: [],
    typedHooks: [],
    channels: [],
    providers: [],
    gatewayHandlers: {},
    httpHandlers: [],
    httpRoutes: [],
    cliRegistrars: [],
    services: [],
    commands: [],
    diagnostics: [],
  };
}

// src/plugins/runtime.ts
var REGISTRY_STATE = /* @__PURE__ */ Symbol.for("bitterbot.pluginRegistryState");
var state = (() => {
  const globalState = globalThis;
  if (!globalState[REGISTRY_STATE]) {
    globalState[REGISTRY_STATE] = {
      registry: createEmptyPluginRegistry(),
      key: null,
    };
  }
  return globalState[REGISTRY_STATE];
})();

// src/channels/registry.ts
var CHAT_CHANNEL_ORDER = ["telegram", "whatsapp", "discord", "slack", "signal", "imessage"];
var CHANNEL_IDS = [...CHAT_CHANNEL_ORDER];

// src/terminal/progress-line.ts
var activeStream = null;
function clearActiveProgressLine() {
  if (!activeStream?.isTTY) {
    return;
  }
  activeStream.write("\r\x1B[2K");
}

// src/logging/console.ts
import { createRequire as createRequire2 } from "node:module";
import util from "node:util";

// src/terminal/ansi.ts
var ANSI_SGR_PATTERN = "\\x1b\\[[0-9;]*m";
var OSC8_PATTERN = "\\x1b\\]8;;.*?\\x1b\\\\|\\x1b\\]8;;\\x1b\\\\";
var ANSI_REGEX2 = new RegExp(ANSI_SGR_PATTERN, "g");
var OSC8_REGEX = new RegExp(OSC8_PATTERN, "g");

// src/logging/console.ts
var requireConfig2 = createRequire2(import.meta.url);
var loadConfigFallbackDefault = () => {
  try {
    const loaded = requireConfig2("../config/config.js");
    return loaded.loadConfig?.().logging;
  } catch {
    return void 0;
  }
};
var loadConfigFallback = loadConfigFallbackDefault;
function normalizeConsoleLevel(level) {
  if (isVerbose()) {
    return "debug";
  }
  if (!level && process.env.VITEST === "true" && process.env.BITTERBOT_TEST_CONSOLE !== "1") {
    return "silent";
  }
  return normalizeLogLevel(level, "info");
}
function normalizeConsoleStyle(style) {
  if (style === "compact" || style === "json" || style === "pretty") {
    return style;
  }
  if (!process.stdout.isTTY) {
    return "compact";
  }
  return "pretty";
}
function resolveConsoleSettings() {
  let cfg = loggingState.overrideSettings ?? readLoggingConfig();
  if (!cfg) {
    if (loggingState.resolvingConsoleSettings) {
      cfg = void 0;
    } else {
      loggingState.resolvingConsoleSettings = true;
      try {
        cfg = loadConfigFallback();
      } finally {
        loggingState.resolvingConsoleSettings = false;
      }
    }
  }
  const level = normalizeConsoleLevel(cfg?.consoleLevel);
  const style = normalizeConsoleStyle(cfg?.consoleStyle);
  return { level, style };
}
function consoleSettingsChanged(a, b) {
  if (!a) {
    return true;
  }
  return a.level !== b.level || a.style !== b.style;
}
function getConsoleSettings() {
  const settings = resolveConsoleSettings();
  const cached = loggingState.cachedConsoleSettings;
  if (!cached || consoleSettingsChanged(cached, settings)) {
    loggingState.cachedConsoleSettings = settings;
  }
  return loggingState.cachedConsoleSettings;
}
function shouldLogSubsystemToConsole(subsystem) {
  const filter = loggingState.consoleSubsystemFilter;
  if (!filter || filter.length === 0) {
    return true;
  }
  return filter.some((prefix) => subsystem === prefix || subsystem.startsWith(`${prefix}/`));
}

// src/logging/subsystem.ts
function shouldLogToConsole(level, settings) {
  if (settings.level === "silent") {
    return false;
  }
  const current = levelToMinLevel(level);
  const min = levelToMinLevel(settings.level);
  return current <= min;
}
function isRichConsoleEnv() {
  const term = (process.env.TERM ?? "").toLowerCase();
  if (process.env.COLORTERM || process.env.TERM_PROGRAM) {
    return true;
  }
  return term.length > 0 && term !== "dumb";
}
function getColorForConsole() {
  const hasForceColor2 =
    typeof process.env.FORCE_COLOR === "string" &&
    process.env.FORCE_COLOR.trim().length > 0 &&
    process.env.FORCE_COLOR.trim() !== "0";
  if (process.env.NO_COLOR && !hasForceColor2) {
    return new Chalk({ level: 0 });
  }
  const hasTty = Boolean(process.stdout.isTTY || process.stderr.isTTY);
  return hasTty || isRichConsoleEnv() ? new Chalk({ level: 1 }) : new Chalk({ level: 0 });
}
var SUBSYSTEM_COLORS = ["cyan", "green", "yellow", "blue", "magenta", "red"];
var SUBSYSTEM_COLOR_OVERRIDES = {
  "gmail-watcher": "blue",
};
var SUBSYSTEM_PREFIXES_TO_DROP = ["gateway", "channels", "providers"];
var SUBSYSTEM_MAX_SEGMENTS = 2;
var CHANNEL_SUBSYSTEM_PREFIXES = new Set(CHAT_CHANNEL_ORDER);
function pickSubsystemColor(color, subsystem) {
  const override = SUBSYSTEM_COLOR_OVERRIDES[subsystem];
  if (override) {
    return color[override];
  }
  let hash = 0;
  for (let i = 0; i < subsystem.length; i += 1) {
    hash = (hash * 31 + subsystem.charCodeAt(i)) | 0;
  }
  const idx = Math.abs(hash) % SUBSYSTEM_COLORS.length;
  const name = SUBSYSTEM_COLORS[idx];
  return color[name];
}
function formatSubsystemForConsole(subsystem) {
  const parts = subsystem.split("/").filter(Boolean);
  const original = parts.join("/") || subsystem;
  while (parts.length > 0 && SUBSYSTEM_PREFIXES_TO_DROP.includes(parts[0])) {
    parts.shift();
  }
  if (parts.length === 0) {
    return original;
  }
  if (CHANNEL_SUBSYSTEM_PREFIXES.has(parts[0])) {
    return parts[0];
  }
  if (parts.length > SUBSYSTEM_MAX_SEGMENTS) {
    return parts.slice(-SUBSYSTEM_MAX_SEGMENTS).join("/");
  }
  return parts.join("/");
}
function stripRedundantSubsystemPrefixForConsole(message, displaySubsystem) {
  if (!displaySubsystem) {
    return message;
  }
  if (message.startsWith("[")) {
    const closeIdx = message.indexOf("]");
    if (closeIdx > 1) {
      const bracketTag = message.slice(1, closeIdx);
      if (bracketTag.toLowerCase() === displaySubsystem.toLowerCase()) {
        let i2 = closeIdx + 1;
        while (message[i2] === " ") {
          i2 += 1;
        }
        return message.slice(i2);
      }
    }
  }
  const prefix = message.slice(0, displaySubsystem.length);
  if (prefix.toLowerCase() !== displaySubsystem.toLowerCase()) {
    return message;
  }
  const next = message.slice(displaySubsystem.length, displaySubsystem.length + 1);
  if (next !== ":" && next !== " ") {
    return message;
  }
  let i = displaySubsystem.length;
  while (message[i] === " ") {
    i += 1;
  }
  if (message[i] === ":") {
    i += 1;
  }
  while (message[i] === " ") {
    i += 1;
  }
  return message.slice(i);
}
function formatConsoleLine(opts) {
  const displaySubsystem =
    opts.style === "json" ? opts.subsystem : formatSubsystemForConsole(opts.subsystem);
  if (opts.style === "json") {
    return JSON.stringify({
      time: /* @__PURE__ */ new Date().toISOString(),
      level: opts.level,
      subsystem: displaySubsystem,
      message: opts.message,
      ...opts.meta,
    });
  }
  const color = getColorForConsole();
  const prefix = `[${displaySubsystem}]`;
  const prefixColor = pickSubsystemColor(color, displaySubsystem);
  const levelColor =
    opts.level === "error" || opts.level === "fatal"
      ? color.red
      : opts.level === "warn"
        ? color.yellow
        : opts.level === "debug" || opts.level === "trace"
          ? color.gray
          : color.cyan;
  const displayMessage = stripRedundantSubsystemPrefixForConsole(opts.message, displaySubsystem);
  const time = (() => {
    if (opts.style === "pretty") {
      return color.gray(/* @__PURE__ */ new Date().toISOString().slice(11, 19));
    }
    if (loggingState.consoleTimestampPrefix) {
      return color.gray(/* @__PURE__ */ new Date().toISOString());
    }
    return "";
  })();
  const prefixToken = prefixColor(prefix);
  const head = [time, prefixToken].filter(Boolean).join(" ");
  return `${head} ${levelColor(displayMessage)}`;
}
function writeConsoleLine(level, line) {
  clearActiveProgressLine();
  const sanitized =
    process.platform === "win32" && process.env.GITHUB_ACTIONS === "true"
      ? line.replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g, "?").replace(/[\uD800-\uDFFF]/g, "?")
      : line;
  const sink = loggingState.rawConsole ?? console;
  if (loggingState.forceConsoleToStderr || level === "error" || level === "fatal") {
    (sink.error ?? console.error)(sanitized);
  } else if (level === "warn") {
    (sink.warn ?? console.warn)(sanitized);
  } else {
    (sink.log ?? console.log)(sanitized);
  }
}
function logToFile(fileLogger, level, message, meta) {
  if (level === "silent") {
    return;
  }
  const safeLevel = level;
  const method = fileLogger[safeLevel];
  if (typeof method !== "function") {
    return;
  }
  if (meta && Object.keys(meta).length > 0) {
    method.call(fileLogger, meta, message);
  } else {
    method.call(fileLogger, message);
  }
}
function createSubsystemLogger(subsystem) {
  let fileLogger = null;
  const getFileLogger = () => {
    if (!fileLogger) {
      fileLogger = getChildLogger({ subsystem });
    }
    return fileLogger;
  };
  const emit = (level, message, meta) => {
    const consoleSettings = getConsoleSettings();
    let consoleMessageOverride;
    let fileMeta = meta;
    if (meta && Object.keys(meta).length > 0) {
      const { consoleMessage: consoleMessage2, ...rest } = meta;
      if (typeof consoleMessage2 === "string") {
        consoleMessageOverride = consoleMessage2;
      }
      fileMeta = Object.keys(rest).length > 0 ? rest : void 0;
    }
    logToFile(getFileLogger(), level, message, fileMeta);
    if (!shouldLogToConsole(level, { level: consoleSettings.level })) {
      return;
    }
    if (!shouldLogSubsystemToConsole(subsystem)) {
      return;
    }
    const consoleMessage = consoleMessageOverride ?? message;
    if (
      !isVerbose() &&
      subsystem === "agent/embedded" &&
      /(sessionId|runId)=probe-/.test(consoleMessage)
    ) {
      return;
    }
    const line = formatConsoleLine({
      level,
      subsystem,
      message: consoleSettings.style === "json" ? message : consoleMessage,
      style: consoleSettings.style,
      meta: fileMeta,
    });
    writeConsoleLine(level, line);
  };
  const isConsoleEnabled = (level) => {
    const consoleSettings = getConsoleSettings();
    return (
      shouldLogToConsole(level, { level: consoleSettings.level }) &&
      shouldLogSubsystemToConsole(subsystem)
    );
  };
  const isFileEnabled = (level) => isFileLogLevelEnabled(level);
  const logger = {
    subsystem,
    isEnabled: (level, target = "any") => {
      if (target === "console") {
        return isConsoleEnabled(level);
      }
      if (target === "file") {
        return isFileEnabled(level);
      }
      return isConsoleEnabled(level) || isFileEnabled(level);
    },
    trace: (message, meta) => emit("trace", message, meta),
    debug: (message, meta) => emit("debug", message, meta),
    info: (message, meta) => emit("info", message, meta),
    warn: (message, meta) => emit("warn", message, meta),
    error: (message, meta) => emit("error", message, meta),
    fatal: (message, meta) => emit("fatal", message, meta),
    raw: (message) => {
      logToFile(getFileLogger(), "info", message, { raw: true });
      if (shouldLogSubsystemToConsole(subsystem)) {
        if (
          !isVerbose() &&
          subsystem === "agent/embedded" &&
          /(sessionId|runId)=probe-/.test(message)
        ) {
          return;
        }
        writeConsoleLine("info", message);
      }
    },
    child: (name) => createSubsystemLogger(`${subsystem}/${name}`),
  };
  return logger;
}

// src/gateway/a2a/mailbox.ts
import crypto from "node:crypto";

// src/gateway/a2a/types.ts
var A2aErrorCodes = {
  // JSON-RPC standard
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
  // A2A extensions
  TASK_NOT_FOUND: -32001,
  TASK_NOT_CANCELABLE: -32002,
  CONTENT_TYPE_NOT_SUPPORTED: -32003,
  PUSH_NOTIFICATION_NOT_SUPPORTED: -32004,
  UNAUTHORIZED: -32005,
  PAYMENT_REQUIRED: -32006,
};

// src/gateway/a2a/mailbox.ts
var log = createSubsystemLogger("a2a/mailbox");
var MAILBOX_PROOF_DOMAIN = "circle-mailbox/v1";
var MAILBOX_TTL_MS = 30 * 24 * 60 * 60 * 1e3;
var MAILBOX_PROOF_SKEW_MS = 3e5;
var MAX_BLOB_BYTES = 65536;
var RECIPIENT_QUOTA = 500;
function err(code, message) {
  return { ok: false, error: { code, message } };
}
var ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
function verifyProof(args) {
  const match = /^ed25519:([0-9a-f]{64})$/.exec(args.pubkey);
  if (!match || !/^[0-9a-f]{128}$/.test(args.sig)) {
    return false;
  }
  if (typeof args.ts !== "number" || Math.abs(args.now - args.ts) > MAILBOX_PROOF_SKEW_MS) {
    return false;
  }
  try {
    const key = crypto.createPublicKey({
      key: Buffer.concat([ED25519_SPKI_PREFIX, Buffer.from(match[1], "hex")]),
      format: "der",
      type: "spki",
    });
    const preimage = Buffer.from(
      `${MAILBOX_PROOF_DOMAIN}
${args.verb}
${args.pubkey}
${args.ts}
${args.extra}`,
      "utf8",
    );
    return crypto.verify(null, preimage, key, Buffer.from(args.sig, "hex"));
  } catch {
    return false;
  }
}
function blobDigest(recipient, blobJson) {
  return crypto
    .createHash("sha256")
    .update(
      `${recipient}
${blobJson}`,
      "utf8",
    )
    .digest("hex");
}
var POST_LIMIT = { windowMs: 3e5, max: 60 };
var postBuckets = /* @__PURE__ */ new Map();
function postRateLimited(sender, now) {
  const hits = (postBuckets.get(sender) ?? []).filter((t) => now - t < POST_LIMIT.windowMs);
  if (hits.length >= POST_LIMIT.max) {
    postBuckets.set(sender, hits);
    return true;
  }
  hits.push(now);
  postBuckets.set(sender, hits);
  return false;
}
function handleMailboxPost(params, db, now = Date.now()) {
  const { to, blob, proof } = params;
  if (!to || !blob || !proof?.pubkey || !proof.sig || typeof proof.ts !== "number") {
    return err(A2aErrorCodes.INVALID_PARAMS, "to, blob, proof{pubkey,ts,sig} required");
  }
  if (Buffer.byteLength(blob, "utf8") > MAX_BLOB_BYTES) {
    return err(A2aErrorCodes.INVALID_PARAMS, `blob exceeds ${MAX_BLOB_BYTES} bytes`);
  }
  if (
    !verifyProof({
      verb: "post",
      pubkey: proof.pubkey,
      ts: proof.ts,
      extra: blobDigest(to, blob),
      sig: proof.sig,
      now,
    })
  ) {
    return err(A2aErrorCodes.UNAUTHORIZED, "invalid sender proof");
  }
  if (postRateLimited(proof.pubkey, now)) {
    return err(A2aErrorCodes.INVALID_REQUEST, "rate limited; slow down");
  }
  const count = db
    .prepare(`SELECT COUNT(*) AS n FROM mailbox_blobs WHERE recipient_pubkey = ?`)
    .get(to).n;
  if (count >= RECIPIENT_QUOTA) {
    return err(A2aErrorCodes.INVALID_REQUEST, "recipient mailbox is full");
  }
  const blobId = crypto.randomUUID();
  const expiresAt = now + MAILBOX_TTL_MS;
  db.prepare(
    `INSERT INTO mailbox_blobs
       (blob_id, recipient_pubkey, sender_pubkey, blob_json, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(blobId, to, proof.pubkey, blob, now, expiresAt);
  return { ok: true, result: { blobId, expiresAt } };
}
function handleMailboxPoll(params, db, now = Date.now()) {
  const proof = params.proof;
  if (!proof?.pubkey || !proof.sig || typeof proof.ts !== "number") {
    return err(A2aErrorCodes.INVALID_PARAMS, "proof{pubkey,ts,sig} required");
  }
  const since = typeof params.since === "number" ? params.since : 0;
  if (
    !verifyProof({
      verb: "poll",
      pubkey: proof.pubkey,
      ts: proof.ts,
      extra: String(since),
      sig: proof.sig,
      now,
    })
  ) {
    return err(A2aErrorCodes.UNAUTHORIZED, "invalid recipient proof");
  }
  const limit = Math.min(typeof params.limit === "number" ? params.limit : 100, 200);
  const rows = db
    .prepare(
      `SELECT blob_id, sender_pubkey, blob_json, created_at
         FROM mailbox_blobs
        WHERE recipient_pubkey = ? AND created_at > ? AND expires_at > ?
        ORDER BY created_at ASC LIMIT ?`,
    )
    .all(proof.pubkey, since, now, limit);
  return {
    ok: true,
    result: {
      blobs: rows.map((r) => ({
        blobId: r.blob_id,
        senderPubkey: r.sender_pubkey,
        blob: r.blob_json,
        createdAt: r.created_at,
      })),
    },
  };
}
function handleMailboxAck(params, db, now = Date.now()) {
  const proof = params.proof;
  const blobIds = Array.isArray(params.blobIds)
    ? params.blobIds.filter((b) => typeof b === "string").slice(0, 200)
    : [];
  if (!proof?.pubkey || !proof.sig || typeof proof.ts !== "number" || blobIds.length === 0) {
    return err(A2aErrorCodes.INVALID_PARAMS, "proof{pubkey,ts,sig}, blobIds required");
  }
  if (
    !verifyProof({
      verb: "ack",
      pubkey: proof.pubkey,
      ts: proof.ts,
      extra: blobIds.join(","),
      sig: proof.sig,
      now,
    })
  ) {
    return err(A2aErrorCodes.UNAUTHORIZED, "invalid recipient proof");
  }
  let deleted = 0;
  const stmt = db.prepare(`DELETE FROM mailbox_blobs WHERE blob_id = ? AND recipient_pubkey = ?`);
  for (const id of blobIds) {
    deleted += Number(stmt.run(id, proof.pubkey).changes);
  }
  return { ok: true, result: { deleted } };
}
function sweepExpiredMailboxBlobs(db, now = Date.now()) {
  const res = db.prepare(`DELETE FROM mailbox_blobs WHERE expires_at <= ?`).run(now);
  const n = Number(res.changes);
  if (n > 0) {
    log.debug(`mailbox sweep: purged ${n} expired blob(s)`);
  }
  return n;
}
function handleMailboxMethod(method, params, db, now = Date.now()) {
  const p = params ?? {};
  switch (method) {
    case "mailbox/post":
      return handleMailboxPost(p, db, now);
    case "mailbox/poll":
      return handleMailboxPoll(p, db, now);
    case "mailbox/ack":
      return handleMailboxAck(p, db, now);
    default:
      return err(A2aErrorCodes.METHOD_NOT_FOUND, `Unknown mailbox method: ${method}`);
  }
}

// src/gateway/a2a/mailbox-host.ts
var log2 = createSubsystemLogger("a2a/mailbox-host");
var MAX_REQUEST_BYTES = 128 * 1024;
var SWEEP_INTERVAL_MS = 60 * 6e4;
function ensureMailboxSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS mailbox_blobs (
      blob_id          TEXT PRIMARY KEY,
      recipient_pubkey TEXT NOT NULL,
      sender_pubkey    TEXT NOT NULL,
      blob_json        TEXT NOT NULL,
      created_at       INTEGER NOT NULL,
      expires_at       INTEGER NOT NULL
    )
  `);
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_mailbox_blobs_recipient ON mailbox_blobs(recipient_pubkey, created_at)`,
  );
}
function readBody(req) {
  return new Promise((resolve) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > MAX_REQUEST_BYTES) {
        resolve(null);
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", () => resolve(null));
  });
}
function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json" });
  res.end(payload);
}
function startMailboxHost(opts) {
  const path7 = opts.path ?? "/a2a";
  const db = new DatabaseSync(opts.dbPath ?? ":memory:");
  ensureMailboxSchema(db);
  const server = createServer((req, res) => {
    void handle2(req, res);
  });
  async function handle2(req, res) {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/health")) {
      sendJson(res, 200, { ok: true, service: "circles-mailbox" });
      return;
    }
    if (req.method !== "POST" || url.pathname !== path7) {
      sendJson(res, 404, { error: "not found" });
      return;
    }
    const raw = await readBody(req);
    if (raw === null) {
      sendJson(res, 413, { error: "request too large or unreadable" });
      return;
    }
    let rpc;
    try {
      rpc = JSON.parse(raw);
    } catch {
      sendJson(res, 400, {
        jsonrpc: "2.0",
        error: { code: -32700, message: "parse error" },
        id: null,
      });
      return;
    }
    const method = typeof rpc.method === "string" ? rpc.method : "";
    const id = rpc.id ?? null;
    if (!method.startsWith("mailbox/")) {
      sendJson(res, 404, {
        jsonrpc: "2.0",
        error: { code: -32601, message: "method not found (mailbox host serves mailbox/* only)" },
        id,
      });
      return;
    }
    const outcome = handleMailboxMethod(method, rpc.params, db, Date.now());
    sendJson(
      res,
      200,
      outcome.ok
        ? { jsonrpc: "2.0", result: outcome.result, id }
        : { jsonrpc: "2.0", error: outcome.error, id },
    );
  }
  const sweep = setInterval(() => {
    try {
      const removed = sweepExpiredMailboxBlobs(db, Date.now());
      if (removed > 0) log2.debug(`swept ${removed} expired mailbox blob(s)`);
    } catch (err2) {
      log2.debug(`mailbox sweep failed: ${String(err2)}`);
    }
  }, SWEEP_INTERVAL_MS);
  sweep.unref?.();
  return new Promise((resolve, reject) => {
    server.on("error", reject);
    server.listen(opts.port, opts.host ?? "0.0.0.0", () => {
      const addr = server.address();
      const port2 = typeof addr === "object" && addr ? addr.port : opts.port;
      log2.info(
        `mailbox host listening on ${opts.host ?? "0.0.0.0"}:${port2} (db=${opts.dbPath ?? ":memory:"})`,
      );
      resolve({
        port: port2,
        close: () =>
          new Promise((res) => {
            clearInterval(sweep);
            server.close(() => {
              db.close();
              res();
            });
          }),
      });
    });
  });
}

// scripts/mailbox-host.ts
var port = Number(process.env.MAILBOX_PORT ?? 8790);
var host = process.env.MAILBOX_HOST ?? "0.0.0.0";
var dbPath = process.env.MAILBOX_DB ?? "./mailbox.sqlite";
var handle = await startMailboxHost({ port, host, dbPath });
console.log(`circles mailbox host listening on ${host}:${handle.port} (db=${dbPath})`);
var shutdown = () => {
  void handle.close().then(() => process.exit(0));
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
