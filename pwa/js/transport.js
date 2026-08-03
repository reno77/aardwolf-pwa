// transport.js -- the one place the client touches the outside world.
//
// The client speaks a tiny JSON protocol and does not care what carries it:
//
//   out  {action:'connect'} | {action:'ping'} | {action:'gmcp_request'} | {cmd:'...'}
//   in   {type:'text'|'echo'|'system'|'error'|'quest'|'pong'} | {type:'gmcp',key,data}
//
// In a browser that protocol rides a WebSocket to relay_minimal.py, which owns
// the TCP session to aardwolf.org:4000 -- a browser cannot open a raw socket, so
// something on the far side has to. In the Android app there is no far side:
// MudService holds the socket itself and hands the same JSON to the WebView
// through a @JavascriptInterface bridge.
//
// Rather than teach net.js about both, `openTransport()` returns an object with
// the four handlers and two methods net.js actually uses, so the connection code
// is identical either way and the browser build is unaffected.

import { WS_URL } from './state.js';

/** True when running inside the Android wrapper. */
export function isNativeHost(){ return typeof window !== 'undefined' && !!window.AardNative; }

/**
 * A WebSocket-shaped façade over the Android bridge.
 *
 * Only the surface net.js uses is implemented: onopen/onmessage/onclose/onerror,
 * send() and close(). onmessage receives {data:<string>} so the JSON.parse on the
 * other side needs no special case.
 */
class NativeTransport {
  constructor(){
    this.onopen = null;
    this.onmessage = null;
    this.onclose = null;
    this.onerror = null;
    this._closed = false;
    activeTransport = this;
    // A real WebSocket never fires onopen synchronously from its constructor,
    // and net.js assigns the handlers immediately after constructing -- so
    // firing inline would run before onopen was set and the client would sit
    // there connected but never having said {action:'connect'}.
    setTimeout(() => {
      if (this._closed) return;
      if (this.onopen) this.onopen();
    }, 0);
  }

  send(text){
    if (this._closed) return;
    try {
      window.AardNative.send(text);
    } catch (e) {
      if (this.onerror) this.onerror(e);
    }
  }

  close(){
    if (this._closed) return;
    this._closed = true;
    if (activeTransport === this) activeTransport = null;
    // Deliberately does NOT tell the service to drop the MUD session: closing
    // the page's transport is not the same as logging out. The TCP session
    // outlives the WebView so that a rotation, a reload, or Android recreating
    // the Activity does not make the character go link-dead. Quitting is an
    // explicit action from the notification.
    if (this.onclose) this.onclose();
  }

  /** Called from the native side via the global receiver below. */
  _deliver(text){
    if (this._closed) return;
    if (this.onmessage) this.onmessage({ data: text });
  }
}

// The bridge can only reach global functions, and only one transport is live at
// a time, so the receiver is installed once and routes to whichever transport
// is current. A message arriving between transports is dropped rather than
// delivered to a closed one -- the reattach on the next {action:'connect'}
// re-requests GMCP state, so nothing is permanently lost.
let activeTransport = null;

if (typeof window !== 'undefined') {
  window.__aardNativeRecv = function(text){
    if (activeTransport) activeTransport._deliver(text);
  };
}

/** A WebSocket in the browser, the native bridge in the Android app. */
export function openTransport(){
  if (isNativeHost()) return new NativeTransport();
  return new WebSocket(WS_URL);
}

// =============================================================================
// FILE TRANSFER
// =============================================================================
// /export builds a Blob and clicks an <a download>; /import opens an
// <input type=file>. Neither does anything at all inside an Android WebView --
// no error, no download, no picker -- so both would be dead buttons in the app.
// Since those two are how a database full of mapping, aliases, triggers and
// shortcut buttons moves between the browser client and the app, they go through
// the system document picker instead.
//
// Transfers are chunked in both directions: a map database runs to several
// megabytes and neither the JavaScript bridge nor evaluateJavascript promises to
// carry a string that size in one piece.

const CHUNK_BYTES = 96 * 1024;

/** Uint8Array -> base64, without a stack-blowing spread of the whole array. */
function toBase64(u8){
  let s = '';
  const step = 0x8000;
  for (let i = 0; i < u8.length; i += step){
    s += String.fromCharCode.apply(null, u8.subarray(i, i + step));
  }
  return btoa(s);
}

function fromBase64(b64){
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Hand `bytes` to the system "save as" picker. Native host only. */
export function nativeSaveFile(filename, bytes){
  const B = window.AardNative;
  B.fileBegin();
  // Each chunk is encoded and decoded independently, so the split point does not
  // have to fall on a base64 group boundary.
  for (let i = 0; i < bytes.length; i += CHUNK_BYTES){
    B.fileChunk(toBase64(bytes.subarray(i, i + CHUNK_BYTES)));
  }
  B.fileSave(filename);
}

/** Open the system file picker; resolves with the bytes. Native host only. */
export function nativeOpenFile(mimeType){
  return new Promise((resolve, reject) => {
    const parts = [];
    let total = 0;
    window.__aardFileChunk = (b64) => {
      const bytes = fromBase64(b64);
      parts.push(bytes);
      total += bytes.length;
    };
    window.__aardFileDone = (err) => {
      // Replaced with no-ops rather than deleted: a late or duplicate call from
      // the native side should do nothing, not throw inside the bridge.
      window.__aardFileChunk = () => {};
      window.__aardFileDone = () => {};
      if (err) { reject(new Error(String(err))); return; }
      const out = new Uint8Array(total);
      let at = 0;
      for (const p of parts){ out.set(p, at); at += p.length; }
      resolve(out);
    };
    try {
      window.AardNative.fileOpen(mimeType || '*/*');
    } catch (e) {
      window.__aardFileDone(e.message || 'could not open the file picker');
    }
  });
}
