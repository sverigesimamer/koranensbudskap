// WebGL2 renderer for the turning sheet.
//
// It only ever *presents* the PDF canvases: the two canvases PDF.js rendered
// for the front and back of the leaf are uploaded as textures and mapped onto
// a bent mesh. Nothing is drawn back into the PDF canvases.
//
// Per frame:
//   1. the bent sheet is projected along the light onto the book plane and
//      drawn into a small offscreen buffer, which is then blurred (soft shadow)
//   2. the shadow is composited over the page (the canvas is transparent and
//      sits above the DOM pages, so it darkens whatever is underneath)
//   3. the sheet itself is drawn with per-pixel lighting, front/back textures
//      and the same gutter shading the resting pages use.

import { PROFILE_SAMPLES } from './curl-solver.js';

const GRID_X = 72;
const GRID_Y = 48;
const MAX_STOPS = 8;
const SHADOW_SCALE = 0.5; // shadow buffer resolution relative to CSS pixels

const SHEET_VERT = `#version 300 es
precision highp float;
in vec2 aUV;
uniform vec2 uPage;
uniform vec2 uN;
uniform float uL0;
uniform float uD;
uniform vec3 uProf[${PROFILE_SAMPLES}];
uniform float uSide;
uniform vec2 uOrigin;
uniform vec2 uView;
uniform vec3 uCam;
uniform vec2 uShadowOff;
uniform float uShadowPass;
uniform float uBoardScale; // 1 for a leaf; > 1 for the cover board, which overhangs the pages
uniform float uLayer;      // offset along the surface normal (board thickness)
out vec2 vUV;
out vec2 vPagePos;
out vec3 vNormal;
out vec3 vWorld;

void main() {
  vec2 pos = aUV * uPage;
  // The board grows out from the spine and from the middle of its height.
  pos = vec2(pos.x * uBoardScale, uPage.y * 0.5 + (pos.y - uPage.y * 0.5) * uBoardScale);
  vPagePos = pos / uPage;
  float c = dot(pos, uN) - uL0;
  vec2 p2 = pos;
  float z = 0.0;
  float th = 0.0;
  if (c > 0.0) {
    float f = clamp(c / uD, 0.0, 1.0) * float(${PROFILE_SAMPLES - 1});
    int i = min(int(f), ${PROFILE_SAMPLES - 2});
    vec3 pr = mix(uProf[i], uProf[i + 1], f - float(i));
    p2 = pos - uN * c + uN * (pr.x * uD);
    z = pr.y * uD + pr.z * 0.25; // tiny lift keeps a folded-over flap above the flat part
    th = pr.z;
  }
  vec3 nrm = vec3(-uN * sin(th), cos(th));
  p2 += nrm.xy * uLayer;
  z += nrm.z * uLayer;
  vec2 world = uOrigin + vec2(uSide * p2.x, p2.y);
  vUV = aUV;
  vNormal = vec3(uSide * nrm.x, nrm.y, nrm.z);
  vWorld = vec3(world, z);

  vec2 halfView = uView * 0.5;
  if (uShadowPass > 0.5) {
    vec2 s = world + uShadowOff * z;
    gl_Position = vec4((s.x - halfView.x) / halfView.x, -(s.y - halfView.y) / halfView.y, 0.0, 1.0);
  } else {
    // Pinhole camera straight above the book: the plane z = 0 maps 1:1 onto
    // the DOM, raised parts loom towards the viewer.
    float w = (uCam.z - z) / uCam.z;
    vec2 clip = ((uCam.xy - halfView) * w + (world - uCam.xy)) / halfView;
    gl_Position = vec4(clip.x, -clip.y, -0.9 * (z / uCam.z) * w, w);
  }
}`;

const SHEET_FRAG = `#version 300 es
precision highp float;
in vec2 vUV;
in vec2 vPagePos;
in vec3 vNormal;
in vec3 vWorld;
// 0: a leaf (front and back of one surface)
// 1: the face of the cover board that starts facing up, 2: its other face,
// 3: the board's edge
uniform int uFace;
// Whether face 1 is the inside of the cover (a page mounted on the board)
// rather than its outside (the cover artwork filling the whole board).
uniform bool uUpInset;
uniform float uBoardScale;
uniform sampler2D uFront;
uniform sampler2D uBack;
uniform sampler2D uShadow;
uniform float uSide;
uniform vec2 uView;
uniform vec3 uCam;
uniform vec3 uLight;
uniform float uDiffuse;
uniform float uAmbient;
uniform float uCurve;
uniform vec2 uShadowOff;
uniform float uShadowStrength;
uniform float uLift;
uniform vec2 uDark[${MAX_STOPS}];
uniform int uDarkCount;
uniform vec2 uLightStops[${MAX_STOPS}];
uniform int uLightCount;
out vec4 outColor;

float stops(vec2 s[${MAX_STOPS}], int count, float x) {
  if (count == 0) return 0.0;
  if (x <= s[0].x) return s[0].y;
  for (int i = 1; i < ${MAX_STOPS}; i++) {
    if (i >= count) break;
    if (x <= s[i].x) {
      return mix(s[i - 1].y, s[i].y, (x - s[i - 1].x) / max(s[i].x - s[i - 1].x, 1e-5));
    }
  }
  return s[count - 1].y;
}

// The cover material — the --board-* colours of styles.css.
uniform vec3 uBoardTop;
uniform vec3 uBoardMid;
uniform vec3 uBoardBottom;
uniform vec3 uBoardEdge;
vec3 boardColor() {
  float y = clamp((vPagePos.y - 0.5) / uBoardScale + 0.5, 0.0, 1.0);
  return y < 0.6 ? mix(uBoardTop, uBoardMid, y / 0.6) : mix(uBoardMid, uBoardBottom, (y - 0.6) / 0.4);
}

void main() {
  vec3 N = normalize(vNormal);
  vec3 V = normalize(vec3(uCam.xy - vWorld.xy, uCam.z - vWorld.z));
  bool facing = dot(N, V) > 0.0;
  vec3 Nf = facing ? N : -N;
  // Which of the two textures this surface carries.
  bool front = uFace == 0 ? facing : uFace == 1;
  bool mirror = (uSide > 0.0) != front;
  vec3 col;

  if (uFace == 3) {
    col = uBoardEdge;
  } else if (uFace != 0 && (front != uUpInset)) {
    // Outside of the cover: the artwork fills the board.
    vec2 uv = vec2(mirror ? 1.0 - vUV.x : vUV.x, vUV.y);
    col = front ? texture(uFront, uv).rgb : texture(uBack, uv).rgb;
  } else {
    // A page: vPagePos.x runs from the spine outwards. The front shows the
    // page as it lay on its own side, the back shows the page that lands on
    // the other side. On the cover board the page is mounted on the board,
    // which shows around it.
    vec2 pp = uFace == 0 ? vUV : vPagePos;
    if (pp.x > 1.0 || pp.y < 0.0 || pp.y > 1.0) {
      col = boardColor();
    } else {
      vec2 uv = vec2(mirror ? 1.0 - pp.x : pp.x, pp.y);
      col = front ? texture(uFront, uv).rgb : texture(uBack, uv).rgb;
      // Same gutter light/shade as the resting DOM pages.
      col = mix(col, vec3(1.0), stops(uLightStops, uLightCount, pp.x));
      col *= 1.0 - stops(uDark, uDarkCount, pp.x);
    }
  }

  // Lighting changes as the sheet bends; a flat page is exactly neutral.
  float shade = 1.0 + uDiffuse * (dot(Nf, uLight) - uLight.z) - uCurve * (1.0 - abs(N.z));
  if (shade > 1.0) {
    col = mix(col, vec3(1.0), min((shade - 1.0) * 1.6, 0.35));
  } else {
    col *= max(shade, uAmbient);
  }

  // The flat part of the sheet receives the shadow of the lifted part.
  vec2 g = vWorld.xy + uShadowOff * vWorld.z;
  float sh = texture(uShadow, vec2(g.x / uView.x, 1.0 - g.y / uView.y)).r;
  col *= 1.0 - sh * uShadowStrength * (1.0 - smoothstep(0.0, uLift, vWorld.z));

  outColor = vec4(col, 1.0);
}`;

const SHADOW_FRAG = `#version 300 es
precision highp float;
in vec3 vWorld;
uniform float uLift;
uniform float uFalloff;
out vec4 outColor;
void main() {
  // Parts still lying on the book cast nothing; the shadow grows with height.
  // uFalloff > 0 fades it out again higher up (contact shadow).
  float a = smoothstep(0.0, uLift, vWorld.z) * exp(-vWorld.z * uFalloff);
  outColor = vec4(a);
}`;

const QUAD_VERT = `#version 300 es
in vec2 aPos;
out vec2 vUV;
void main() {
  vUV = aPos * 0.5 + 0.5;
  gl_Position = vec4(aPos, 0.0, 1.0);
}`;

const BLUR_FRAG = `#version 300 es
precision highp float;
in vec2 vUV;
uniform sampler2D uTex;
uniform vec2 uStep;
out vec4 outColor;
void main() {
  vec2 a = texture(uTex, vUV).rg * 0.2270270;
  a += (texture(uTex, vUV + uStep * 1.3846154).rg + texture(uTex, vUV - uStep * 1.3846154).rg) * 0.3162162;
  a += (texture(uTex, vUV + uStep * 3.2307692).rg + texture(uTex, vUV - uStep * 3.2307692).rg) * 0.0702703;
  outColor = vec4(a, 0.0, 1.0);
}`;

const COMPOSITE_FRAG = `#version 300 es
precision highp float;
in vec2 vUV;
uniform sampler2D uTex;
uniform float uStrength;
uniform float uContact;
out vec4 outColor;
void main() {
  // r: shadow thrown along the light, g: contact shadow straight below.
  vec2 s = texture(uTex, vUV).rg;
  float a = 1.0 - (1.0 - s.r * uStrength) * (1.0 - s.g * uContact);
  outColor = vec4(0.0, 0.0, 0.0, a);
}`;

function compile(gl, type, source) {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    throw new Error(gl.getShaderInfoLog(shader) || 'shader compile failed');
  }
  return shader;
}

function link(gl, vert, frag, attribs) {
  const program = gl.createProgram();
  gl.attachShader(program, compile(gl, gl.VERTEX_SHADER, vert));
  gl.attachShader(program, compile(gl, gl.FRAGMENT_SHADER, frag));
  attribs.forEach((name, i) => gl.bindAttribLocation(program, i, name));
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    throw new Error(gl.getProgramInfoLog(program) || 'program link failed');
  }
  const uniforms = {};
  const count = gl.getProgramParameter(program, gl.ACTIVE_UNIFORMS);
  for (let i = 0; i < count; i++) {
    const name = gl.getActiveUniform(program, i).name.replace(/\[0\]$/, '');
    uniforms[name] = gl.getUniformLocation(program, name);
  }
  return { program, uniforms };
}

function flattenStops(list) {
  const out = new Float32Array(MAX_STOPS * 2);
  list.slice(0, MAX_STOPS).forEach(([x, a], i) => {
    out[i * 2] = x;
    out[i * 2 + 1] = a;
  });
  return out;
}

export class FlipRenderer {
  /**
   * @param {HTMLCanvasElement} canvas transparent overlay covering the viewport
   * @param {{light: object, pageShade: object}} options
   */
  constructor(canvas, { light, pageShade }) {
    this.canvas = canvas;
    this.light = light;
    const gl = canvas.getContext('webgl2', {
      alpha: true,
      antialias: true,
      depth: true,
      premultipliedAlpha: true
    });
    if (!gl) throw new Error('WebGL2 is not available');
    this.gl = gl;

    this.sheet = link(gl, SHEET_VERT, SHEET_FRAG, ['aUV']);
    this.shadow = link(gl, SHEET_VERT, SHADOW_FRAG, ['aUV']);
    this.blur = link(gl, QUAD_VERT, BLUR_FRAG, ['aPos']);
    this.composite = link(gl, QUAD_VERT, COMPOSITE_FRAG, ['aPos']);

    this.darkStops = flattenStops(pageShade.dark);
    this.darkCount = Math.min(pageShade.dark.length, MAX_STOPS);
    this.lightStops = flattenStops(pageShade.light);
    this.lightCount = Math.min(pageShade.light.length, MAX_STOPS);

    const len = Math.hypot(...light.direction);
    this.lightDir = light.direction.map((v) => v / len);
    // Where a point at height z drops its shadow on the book plane.
    this.shadowOff = [-this.lightDir[0] / this.lightDir[2], -this.lightDir[1] / this.lightDir[2]];

    this.#buildMesh();
    this.#buildQuad();

    // Two leaves' worth of textures: 'main' for the sheet being turned, 'fan'
    // shared by the sheets flicked past during a jump through the book.
    this.textureSets = {
      main: { front: this.#createTexture(), back: this.#createTexture() },
      fan: { front: this.#createTexture(), back: this.#createTexture() }
    };
    this.loaded = {};
    this.targets = [null, null];
    this.viewW = 0;
    this.viewH = 0;
    this.dpr = 1;

    const aniso = gl.getExtension('EXT_texture_filter_anisotropic');
    if (aniso) {
      const max = Math.min(8, gl.getParameter(aniso.MAX_TEXTURE_MAX_ANISOTROPY_EXT));
      for (const set of Object.values(this.textureSets)) {
        for (const tex of Object.values(set)) {
          gl.bindTexture(gl.TEXTURE_2D, tex);
          gl.texParameterf(gl.TEXTURE_2D, aniso.TEXTURE_MAX_ANISOTROPY_EXT, max);
        }
      }
    }
  }

  #buildMesh() {
    const gl = this.gl;
    const verts = new Float32Array((GRID_X + 1) * (GRID_Y + 1) * 2);
    let v = 0;
    for (let y = 0; y <= GRID_Y; y++) {
      for (let x = 0; x <= GRID_X; x++) {
        verts[v++] = x / GRID_X;
        verts[v++] = y / GRID_Y;
      }
    }
    const indices = new Uint16Array(GRID_X * GRID_Y * 6);
    let i = 0;
    for (let y = 0; y < GRID_Y; y++) {
      for (let x = 0; x < GRID_X; x++) {
        const a = y * (GRID_X + 1) + x;
        const b = a + 1;
        const c = a + GRID_X + 1;
        const d = c + 1;
        indices[i++] = a; indices[i++] = c; indices[i++] = b;
        indices[i++] = b; indices[i++] = c; indices[i++] = d;
      }
    }
    this.meshVao = gl.createVertexArray();
    gl.bindVertexArray(this.meshVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
    gl.bufferData(gl.ARRAY_BUFFER, verts, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, gl.createBuffer());
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, indices, gl.STATIC_DRAW);
    this.indexCount = indices.length;
    gl.bindVertexArray(null);
  }

  #buildQuad() {
    const gl = this.gl;
    this.quadVao = gl.createVertexArray();
    gl.bindVertexArray(this.quadVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);
  }

  #createTexture() {
    const gl = this.gl;
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    return tex;
  }

  #createTarget(w, h) {
    const gl = this.gl;
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    const fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return { tex, fbo, w, h };
  }

  /** Match the overlay to the viewport. Sizes are CSS pixels. */
  resize(viewW, viewH, dpr) {
    const gl = this.gl;
    const pw = Math.max(1, Math.round(viewW * dpr));
    const ph = Math.max(1, Math.round(viewH * dpr));
    if (this.canvas.width !== pw || this.canvas.height !== ph) {
      this.canvas.width = pw;
      this.canvas.height = ph;
    }
    this.viewW = viewW;
    this.viewH = viewH;
    this.dpr = dpr;

    const sw = Math.max(1, Math.ceil(viewW * SHADOW_SCALE));
    const sh = Math.max(1, Math.ceil(viewH * SHADOW_SCALE));
    if (!this.targets[0] || this.targets[0].w !== sw || this.targets[0].h !== sh) {
      for (const t of this.targets) {
        if (t) {
          gl.deleteTexture(t.tex);
          gl.deleteFramebuffer(t.fbo);
        }
      }
      this.targets = [this.#createTarget(sw, sh), this.#createTarget(sw, sh)];
    }
  }

  /** The cover material, read once from the --board-* CSS variables. */
  #boardColors() {
    if (!this.boardColors) {
      const style = getComputedStyle(document.documentElement);
      const read = (name, fallback) => {
        const hex = /^#([0-9a-f]{6})$/i.exec(style.getPropertyValue(name).trim());
        const value = parseInt(hex ? hex[1] : fallback, 16);
        return new Float32Array([(value >> 16) / 255, ((value >> 8) & 255) / 255, (value & 255) / 255]);
      };
      this.boardColors = {
        top: read('--board-top', 'f4f5f7'),
        mid: read('--board-mid', 'e9ebef'),
        bottom: read('--board-bottom', 'dcdfe5'),
        edge: read('--board-edge', 'b7bcc6')
      };
    }
    return this.boardColors;
  }

  /** Forget the uploaded sheet (the page canvases were re-rendered). */
  invalidateSheet() {
    this.loaded = {};
  }

  /**
   * Upload the PDF canvases shown on the two faces of the leaf.
   * A missing page (outside the PDF) becomes plain paper.
   * @param {HTMLCanvasElement|null} front
   * @param {HTMLCanvasElement|null} back
   * @param {'main'|'fan'} [set] which leaf these are for
   */
  setSheet(front, back, set = 'main') {
    const gl = this.gl;
    // Hovering along an edge starts many short sessions with the same leaf.
    const loaded = this.loaded[set];
    if (loaded && loaded.front === front && loaded.back === back) return;
    this.loaded[set] = { front, back };
    const textures = this.textureSets[set];
    const upload = (tex, source) => {
      gl.bindTexture(gl.TEXTURE_2D, tex);
      if (source) {
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
      } else {
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE,
          new Uint8Array([250, 247, 238, 255]));
      }
      gl.generateMipmap(gl.TEXTURE_2D);
    };
    upload(textures.front, front);
    upload(textures.back, back);
  }

  #sheetUniforms(u, frame) {
    const gl = this.gl;
    gl.uniform2f(u.uPage, frame.pageW, frame.pageH);
    gl.uniform2f(u.uN, frame.curl.nx, frame.curl.ny);
    gl.uniform1f(u.uL0, frame.curl.l0);
    gl.uniform1f(u.uD, frame.curl.D);
    gl.uniform3fv(u.uProf, frame.curl.profile);
    gl.uniform1f(u.uSide, frame.side);
    gl.uniform2f(u.uOrigin, frame.spineX, frame.top);
    gl.uniform2f(u.uView, this.viewW, this.viewH);
    gl.uniform3f(u.uCam, frame.spineX, frame.top + frame.pageH / 2, frame.cameraZ);
    gl.uniform2f(u.uShadowOff, this.shadowOff[0], this.shadowOff[1]);
    gl.uniform1f(u.uLift, frame.pageW * 0.05);
    gl.uniform1f(u.uBoardScale, frame.board ? frame.board.scale : 1);
    gl.uniform1f(u.uLayer, 0);
  }

  /**
   * @param {Object} frame
   * @param {number} frame.side     +1: right-hand page is turning, -1: left-hand page
   * @param {number} frame.spineX   spine position, CSS px in the viewport
   * @param {number} frame.top      top of the pages, CSS px in the viewport
   * @param {number} frame.pageW
   * @param {number} frame.pageH
   * @param {number} frame.cameraZ  camera height in CSS px
   * @param {object} frame.curl     result of solveCurl()
   * @param {{scale: number, thickness: number, upInset: boolean}|null} [frame.board]
   *   set when the sheet is the rigid cover board instead of a paper leaf
   * @param {'main'|'fan'} [frame.set] which textures the sheet carries
   *
   * Pass an array to draw several sheets in the air at once; they share the
   * shadow and hide each other correctly.
   */
  draw(frameOrFrames) {
    const frames = Array.isArray(frameOrFrames) ? frameOrFrames : [frameOrFrames];
    const gl = this.gl;
    const [a, b] = this.targets;

    // 1. Shadow mask.
    gl.bindFramebuffer(gl.FRAMEBUFFER, a.fbo);
    gl.viewport(0, 0, a.w, a.h);
    gl.disable(gl.DEPTH_TEST);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.enable(gl.BLEND);
    gl.blendEquation(gl.MAX);
    gl.blendFunc(gl.ONE, gl.ONE);
    gl.useProgram(this.shadow.program);
    gl.bindVertexArray(this.meshVao);
    for (const frame of frames) {
      this.#sheetUniforms(this.shadow.uniforms, frame);
      gl.uniform1f(this.shadow.uniforms.uShadowPass, 1);
      gl.colorMask(true, false, false, false);
      gl.uniform1f(this.shadow.uniforms.uFalloff, 0);
      gl.drawElements(gl.TRIANGLES, this.indexCount, gl.UNSIGNED_SHORT, 0);
      gl.colorMask(false, true, false, false);
      gl.uniform2f(this.shadow.uniforms.uShadowOff, 0, 0);
      gl.uniform1f(this.shadow.uniforms.uFalloff, 1 / (frame.pageW * 0.3));
      gl.drawElements(gl.TRIANGLES, this.indexCount, gl.UNSIGNED_SHORT, 0);
    }
    gl.colorMask(true, true, true, true);
    gl.blendEquation(gl.FUNC_ADD);
    gl.disable(gl.BLEND);

    // 2. Blur it (horizontal a -> b, vertical b -> a).
    const radius = (this.light.shadowBlur * SHADOW_SCALE) / 3.2;
    gl.useProgram(this.blur.program);
    gl.bindVertexArray(this.quadVao);
    gl.activeTexture(gl.TEXTURE0);
    gl.uniform1i(this.blur.uniforms.uTex, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, b.fbo);
    gl.bindTexture(gl.TEXTURE_2D, a.tex);
    gl.uniform2f(this.blur.uniforms.uStep, radius / a.w, 0);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.bindFramebuffer(gl.FRAMEBUFFER, a.fbo);
    gl.bindTexture(gl.TEXTURE_2D, b.tex);
    gl.uniform2f(this.blur.uniforms.uStep, 0, radius / a.h);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

    // 3. Shadow onto whatever lies under the transparent overlay.
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.clearColor(0, 0, 0, 0);
    gl.clearDepth(1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.useProgram(this.composite.program);
    gl.bindTexture(gl.TEXTURE_2D, a.tex);
    gl.uniform1i(this.composite.uniforms.uTex, 0);
    gl.uniform1f(this.composite.uniforms.uStrength, this.light.shadowStrength);
    gl.uniform1f(this.composite.uniforms.uContact, this.light.contactShadow);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

    // 4. The sheets.
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);
    gl.useProgram(this.sheet.program);
    const u = this.sheet.uniforms;
    gl.uniform3fv(u.uLight, this.lightDir);
    gl.uniform1f(u.uDiffuse, this.light.diffuse);
    gl.uniform1f(u.uAmbient, this.light.ambientFloor);
    gl.uniform1f(u.uCurve, this.light.curveShade);
    gl.uniform1f(u.uShadowStrength, this.light.shadowStrength);
    gl.uniform2fv(u.uDark, this.darkStops);
    gl.uniform1i(u.uDarkCount, this.darkCount);
    gl.uniform2fv(u.uLightStops, this.lightStops);
    gl.uniform1i(u.uLightCount, this.lightCount);
    gl.uniform1i(u.uFront, 0);
    gl.uniform1i(u.uBack, 1);
    gl.uniform1i(u.uShadow, 2);
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, a.tex);
    gl.bindVertexArray(this.meshVao);

    for (const frame of frames) {
      this.#sheetUniforms(u, frame);
      gl.uniform1f(u.uShadowPass, 0);
      const textures = this.textureSets[frame.set || 'main'];
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, textures.front);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, textures.back);
      if (frame.board) {
        // The board is a stack of thin layers: its two faces with the edge
        // material in between. Whichever face is visible lies in the page plane
        // at both ends of the turn, so it lines up with the DOM when it lands.
        const { thickness, upInset } = frame.board;
        const layers = Math.max(2, Math.round(thickness));
        const shift = frame.curl.thetaMax / Math.PI - 1;
        gl.uniform1i(u.uUpInset, upInset ? 1 : 0);
        const colors = this.#boardColors();
        gl.uniform3fv(u.uBoardTop, colors.top);
        gl.uniform3fv(u.uBoardMid, colors.mid);
        gl.uniform3fv(u.uBoardBottom, colors.bottom);
        gl.uniform3fv(u.uBoardEdge, colors.edge);
        for (let k = 0; k <= layers; k++) {
          gl.uniform1i(u.uFace, k === layers ? 1 : k === 0 ? 2 : 3);
          gl.uniform1f(u.uLayer, thickness * (k / layers + shift));
          gl.drawElements(gl.TRIANGLES, this.indexCount, gl.UNSIGNED_SHORT, 0);
        }
      } else {
        gl.uniform1i(u.uFace, 0);
        gl.drawElements(gl.TRIANGLES, this.indexCount, gl.UNSIGNED_SHORT, 0);
      }
    }
    gl.activeTexture(gl.TEXTURE0);
    gl.bindVertexArray(null);
    gl.disable(gl.DEPTH_TEST);
  }

  clear() {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
  }
}
