declare module '@novnc/novnc' {
  export default class RFB extends EventTarget {
    constructor(target:HTMLElement,url:string,options?:{shared?:boolean});
    scaleViewport:boolean;
    clipViewport:boolean;
    resizeSession:boolean;
    viewOnly:boolean;
    disconnect():void;
    clipboardPasteFrom(text:string):void;
    sendKey(keysym:number,code:string,down?:boolean):void;
    focus():void;
  }
}
