import type { CustomLayerInterface, Map as MaplibreMap } from 'maplibre-gl';
import { mercatorX, mercatorY, stackFrame, stackHeight, stackTiles, stackTileUrl, type StackRect } from './stackGeometry';

interface StackOptions {
  id: string;
  tileUrl?: string;
  bounds: StackRect;
  maxZoom: number;
  level: number;
  count: number;
  spacing: number;
  opacity: number;
  label: HTMLDivElement;
  axis: SVGLineElement;
  guide: SVGLineElement;
  marker: SVGUseElement;
  groundMarker: SVGUseElement;
  onStatus: (status: string) => void;
}

type Tile = ReturnType<typeof stackTiles>[number] & {
  controller: AbortController;
  bitmap?: ImageBitmap;
  texture?: WebGLTexture;
  failed?: boolean;
};

/** Raised XYZ/WMS imagery using the existing map's camera and GL context. */
export function stackedRasterLayer(options: StackOptions): CustomLayerInterface {
  let map: MaplibreMap, gl: WebGL2RenderingContext, program: WebGLProgram;
  let buffer: WebGLBuffer, vao: WebGLVertexArrayObject;
  let disposed = false;
  const tiles = new Map<string, Tile>();
  const uniform: Record<string, WebGLUniformLocation | null> = {};
  const frame = () => {
    // Layer spacing and tilt must not crop the geographic comparison area.
    return stackFrame(map.getCenter().lng, map.getCenter().lat, map.getZoom(), map.getCanvas().clientWidth);
  };
  const status = () => {
    if (!options.tileUrl) return;
    const values = [...tiles.values()];
    options.onStatus(!values.length ? 'Outside source coverage'
      : values.some((t) => t.failed) ? 'Tiles unavailable · incomplete coverage'
      : values.some((t) => !t.bitmap && !t.texture) ? 'Loading imagery…' : '');
  };
  const discard = (tile: Tile) => {
    tile.controller.abort();
    tile.bitmap?.close();
    if (tile.texture) gl.deleteTexture(tile.texture);
  };
  const load = () => {
    if (!options.tileUrl || disposed) return;
    const wanted = stackTiles(frame(), options.bounds, map.getZoom(), options.maxZoom);
    const keys = new Set(wanted.map((t) => t.key));
    for (const [key, tile] of tiles) {
      if (!keys.has(key)) { discard(tile); tiles.delete(key); }
    }
    for (const spec of wanted) {
      if (tiles.has(spec.key)) continue;
      const tile: Tile = { ...spec, controller: new AbortController() };
      tiles.set(tile.key, tile);
      void fetch(stackTileUrl(options.tileUrl, tile.x, tile.y, tile.z), { signal: tile.controller.signal })
        .then(async (response) => {
          if (!response.ok) throw new Error(`Tile HTTP ${response.status}`);
          const bitmap = await createImageBitmap(await response.blob(), { premultiplyAlpha: 'none' });
          if (disposed || tile.controller.signal.aborted) { bitmap.close(); return; }
          tile.bitmap = bitmap;
          status();
          map.triggerRepaint();
        }).catch(() => {
          if (disposed || tile.controller.signal.aborted) return;
          tile.failed = true;
          status();
          map.triggerRepaint();
        });
    }
    status();
  };
  const repaint = () => map.triggerRepaint();
  let probe: { lng: number; lat: number } | null = null;
  const pointer = (event: { lngLat: { lng: number; lat: number } }) => { probe = event.lngLat; repaint(); };
  const leave = () => { probe = null; repaint(); };

  return {
    id: options.id, type: 'custom', renderingMode: '3d',
    onAdd(instance, context) {
      disposed = false;
      map = instance;
      gl = context;
      const shaders = [
        [gl.VERTEX_SHADER, `#version 300 es
          in vec2 a_pos;
          uniform mat4 u_matrix;
          uniform vec4 u_rect;
          uniform float u_height;
          out vec2 v_uv;
          out vec2 v_pos;
          void main() {
            v_uv = a_pos;
            v_pos = mix(u_rect.xy, u_rect.zw, a_pos);
            gl_Position = u_matrix * vec4(v_pos, u_height, 1.0);
          }`],
        [gl.FRAGMENT_SHADER, `#version 300 es
          precision highp float;
          uniform sampler2D u_image;
          uniform vec4 u_clip;
          uniform vec4 u_color;
          uniform float u_opacity;
          uniform bool u_textured;
          in vec2 v_uv;
          in vec2 v_pos;
          out vec4 color;
          void main() {
            if (any(lessThan(v_pos, u_clip.xy)) || any(greaterThan(v_pos, u_clip.zw))) discard;
            vec4 c = u_textured ? texture(u_image, v_uv) : u_color;
            float alpha = c.a * u_opacity;
            color = vec4(c.rgb * alpha, alpha);
          }`],
      ] as const;
      program = gl.createProgram()!;
      for (const [kind, source] of shaders) {
        const shader = gl.createShader(kind)!;
        gl.shaderSource(shader, source);
        gl.compileShader(shader);
        if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
          const message = gl.getShaderInfoLog(shader);
          gl.deleteShader(shader);
          gl.deleteProgram(program);
          throw new Error(`Stack shader: ${message}`);
        }
        gl.attachShader(program, shader);
        gl.deleteShader(shader);
      }
      gl.linkProgram(program);
      if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error('Stack shader could not link');
      for (const name of ['matrix', 'rect', 'height', 'image', 'clip', 'color', 'opacity', 'textured']) {
        uniform[name] = gl.getUniformLocation(program, `u_${name}`);
      }
      vao = gl.createVertexArray()!;
      gl.bindVertexArray(vao);
      buffer = gl.createBuffer()!;
      gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]), gl.STATIC_DRAW);
      const position = gl.getAttribLocation(program, 'a_pos');
      gl.enableVertexAttribArray(position);
      gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);
      gl.bindVertexArray(null);
      map.on('mousemove', pointer);
      map.on('mouseout', leave);
      load();
    },
    render(context, { defaultProjectionData }) {
      if (disposed) return;
      gl = context;
      if (!map.isMoving()) load();
      const box = frame();
      const cx = (box[0] + box[2]) / 2, cy = (box[1] + box[3]) / 2;
      const height = stackHeight(options.level, options.count, options.spacing, map.getZoom(), map.getCanvas().clientHeight);
      const matrix = [...defaultProjectionData.mainMatrix];
      // Local coordinates retain precision when the map is zoomed to street level.
      for (let i = 0; i < 4; i++) matrix[12 + i] += matrix[i] * cx + matrix[4 + i] * cy;
      const local = (r: StackRect) => [r[0] - cx, r[1] - cy, r[2] - cx, r[3] - cy];
      const project = (x: number, y: number, z: number) => {
        const w = matrix[3] * x + matrix[7] * y + matrix[11] * z + matrix[15];
        return [
          (1 + (matrix[0] * x + matrix[4] * y + matrix[8] * z + matrix[12]) / w) * map.getCanvas().clientWidth / 2,
          (1 - (matrix[1] * x + matrix[5] * y + matrix[9] * z + matrix[13]) / w) * map.getCanvas().clientHeight / 2,
          w,
        ];
      };
      const [labelX, labelY, labelW] = project(box[0] - cx, box[3] - cy, height);
      const viewportWidth = map.getCanvas().clientWidth;
      const gutter = viewportWidth >= 1024 ? 336 : 12;
      const labelLeft = Math.max(gutter, Math.min(labelX, viewportWidth - gutter - options.label.offsetWidth));
      options.label.style.transform = `translate(${labelLeft}px, ${labelY}px) translateY(-100%)`;
      options.label.style.visibility = labelW > 0 ? 'visible' : 'hidden';
      const line = (element: SVGLineElement, x: number, y: number, bottom: number) => {
        const a = project(x, y, bottom), b = project(x, y, height);
        element.setAttribute('x1', String(a[0])); element.setAttribute('y1', String(a[1]));
        element.setAttribute('x2', String(b[0])); element.setAttribute('y2', String(b[1]));
        element.style.visibility = a[2] > 0 && b[2] > 0 ? 'visible' : 'hidden';
      };
      line(options.axis, box[0] - cx, box[3] - cy, height * (options.level - 1) / options.level);

      gl.useProgram(program);
      gl.bindVertexArray(vao);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      gl.disable(gl.DEPTH_TEST);
      gl.depthMask(false);
      gl.disable(gl.CULL_FACE);
      gl.uniformMatrix4fv(uniform.matrix, false, matrix);
      gl.uniform1f(uniform.height, height);
      gl.uniform4fv(uniform.clip, local(box));
      gl.uniform4fv(uniform.rect, local(box));
      gl.uniform1i(uniform.textured, 0);
      gl.uniform1f(uniform.opacity, 1);
      gl.uniform4f(uniform.color, 0.95, 0.96, 0.99, 0.62);
      gl.drawArrays(gl.TRIANGLE_FAN, 0, 4);

      gl.activeTexture(gl.TEXTURE0);
      gl.uniform1i(uniform.image, 0);
      gl.uniform1i(uniform.textured, 1);
      gl.uniform1f(uniform.opacity, options.opacity);
      gl.uniform4fv(uniform.clip, local([
        Math.max(box[0], mercatorX(options.bounds[0])), Math.max(box[1], mercatorY(options.bounds[3])),
        Math.min(box[2], mercatorX(options.bounds[2])), Math.min(box[3], mercatorY(options.bounds[1])),
      ]));
      for (const tile of tiles.values()) {
        if (tile.bitmap) {
          tile.texture = gl.createTexture()!;
          gl.bindTexture(gl.TEXTURE_2D, tile.texture);
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
          gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, tile.bitmap);
          tile.bitmap.close();
          tile.bitmap = undefined;
        }
        if (!tile.texture) continue;
        gl.bindTexture(gl.TEXTURE_2D, tile.texture);
        gl.uniform4fv(uniform.rect, local(tile.rect));
        gl.drawArrays(gl.TRIANGLE_FAN, 0, 4);
      }
      gl.uniform1i(uniform.textured, 0);
      gl.uniform1f(uniform.opacity, 1);
      gl.uniform4fv(uniform.clip, [-2, -2, 2, 2]);
      gl.uniform4fv(uniform.rect, local(box));
      gl.uniform4f(uniform.color, 0.49, 0.23, 0.93, 0.7);
      gl.drawArrays(gl.LINE_LOOP, 0, 4);
      const point = probe ?? map.getCenter();
      const px = mercatorX(point.lng), py = mercatorY(point.lat);
      if (px >= box[0] && px <= box[2] && py >= box[1] && py <= box[3]) {
        line(options.guide, px - cx, py - cy, height * (options.level - 1) / options.level);
        // Screen-space targets stay legible at every tilt, zoom and layer opacity.
        const [x, y, w] = project(px - cx, py - cy, height);
        options.marker.setAttribute('transform', `translate(${x}, ${y})`);
        options.marker.style.visibility = w > 0 ? 'visible' : 'hidden';
        const [groundX, groundY, groundW] = project(px - cx, py - cy, 0);
        options.groundMarker.setAttribute('transform', `translate(${groundX}, ${groundY})`);
        options.groundMarker.style.visibility = options.level === 1 && groundW > 0 ? 'visible' : 'hidden';
      } else {
        options.guide.style.visibility = 'hidden';
        options.marker.style.visibility = 'hidden';
        options.groundMarker.style.visibility = 'hidden';
      }
      gl.bindVertexArray(null);
    },
    onRemove() {
      disposed = true;
      map.off('mousemove', pointer);
      map.off('mouseout', leave);
      tiles.forEach(discard);
      tiles.clear();
      gl.deleteBuffer(buffer);
      gl.deleteVertexArray(vao);
      gl.deleteProgram(program);
    },
  };
}
