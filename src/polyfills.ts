/**
 * @file polyfills.ts
 * Browser polyfills for PDF.js / pdf-parse in Node.js environments.
 */

function install() {
  const g = globalThis as any;
  const root = typeof global !== "undefined" ? (global as any) : g;

  const stubs = {
    DOMMatrix: class DOMMatrix {
      a = 1; b = 0; c = 0; d = 1; e = 0; f = 0;
      m11 = 1; m12 = 0; m13 = 0; m14 = 0;
      m21 = 0; m22 = 1; m23 = 0; m24 = 0;
      m31 = 0; m32 = 0; m33 = 1; m34 = 0;
      m41 = 0; m42 = 0; m43 = 0; m44 = 1;
      is2D = true; isIdentity = true;
      constructor(_init?: string | number[]) { }
      multiply(_m: any) { return new (stubs.DOMMatrix as any)(); }
      translate(_tx = 0, _ty = 0, _tz = 0) { return new (stubs.DOMMatrix as any)(); }
      scale(_sx = 1, _sy?: number, _sz?: number, _ox = 0, _oy = 0, _oz = 0) { return new (stubs.DOMMatrix as any)(); }
      scale3d(_s = 1, _ox = 0, _oy = 0, _oz = 0) { return new (stubs.DOMMatrix as any)(); }
      rotate(_rx = 0, _ry?: number, _rz?: number) { return new (stubs.DOMMatrix as any)(); }
      rotateAxisAngle(_x = 0, _y = 0, _z = 0, _angle = 0) { return new (stubs.DOMMatrix as any)(); }
      skewX(_sx = 0) { return new (stubs.DOMMatrix as any)(); }
      skewY(_sy = 0) { return new (stubs.DOMMatrix as any)(); }
      flipX() { return new (stubs.DOMMatrix as any)(); }
      flipY() { return new (stubs.DOMMatrix as any)(); }
      inverse() { return new (stubs.DOMMatrix as any)(); }
      transformPoint(p?: any) { return p ?? { x: 0, y: 0, z: 0, w: 1 }; }
      toFloat32Array() { return new Float32Array(16); }
      toFloat64Array() { return new Float64Array(16); }
      toJSON() { return {}; }
      toString() { return "matrix(1, 0, 0, 1, 0, 0)"; }
    },
    ImageData: class ImageData {
      readonly data: Uint8ClampedArray;
      readonly width: number;
      readonly height: number;
      readonly colorSpace = "srgb";
      constructor(
        dataOrWidth: Uint8ClampedArray | number,
        widthOrHeight: number,
        heightOrSettings?: number | { colorSpace?: string },
      ) {
        if (typeof dataOrWidth === "number") {
          const h =
            typeof heightOrSettings === "number" ? heightOrSettings : widthOrHeight;
          this.data = new Uint8ClampedArray(dataOrWidth * h * 4);
          this.width = dataOrWidth;
          this.height = h;
        } else {
          this.data = dataOrWidth;
          this.width = widthOrHeight;
          this.height =
            typeof heightOrSettings === "number"
              ? heightOrSettings
              : Math.floor(dataOrWidth.length / 4 / widthOrHeight);
        }
      }
    },
    Path2D: class Path2D {
      constructor(_path?: string | any) { }
      addPath(_path: any, _transform?: any) { }
      closePath() { }
      moveTo(_x: number, _y: number) { }
      lineTo(_x: number, _y: number) { }
      arc(_cx: number, _cy: number, _r: number, _sa: number, _ea: number, _ccw?: boolean) { }
      arcTo(_x1: number, _y1: number, _x2: number, _y2: number, _r: number) { }
      ellipse(_cx: number, _cy: number, _rx: number, _ry: number, _rot: number, _sa: number, _ea: number, _ccw?: boolean) { }
      bezierCurveTo(_cp1x: number, _cp1y: number, _cp2x: number, _cp2y: number, _x: number, _y: number) { }
      quadraticCurveTo(_cpx: number, _cpy: number, _x: number, _y: number) { }
      rect(_x: number, _y: number, _w: number, _h: number) { }
      roundRect(_x: number, _y: number, _w: number, _h: number, _radii?: any) { }
    }
  };

  const targets = [g, root];
  for (const target of targets) {
    if (!target) continue;
    try {
      if (!target.DOMMatrix) target.DOMMatrix = stubs.DOMMatrix;
      if (!target.DOMMatrixReadOnly) target.DOMMatrixReadOnly = stubs.DOMMatrix;
      if (!target.ImageData) target.ImageData = stubs.ImageData;
      if (!target.Path2D) target.Path2D = stubs.Path2D;
      // also provide window for some libraries that check for it
      if (!target.window) target.window = target;
    } catch {
      // ignore
    }
  }
}

install();
