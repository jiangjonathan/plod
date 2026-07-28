/** Bump when shader sources change so cached WebGL programs are recompiled. */
export const POINT_CLOUD_SHADER_VERSION = 17;
export const POINT_CLOUD_CATEGORY_STYLE_LIMIT = 32;

export const POINT_CLOUD_VERTEX_SHADER = `
  attribute vec2 a_position;
  attribute float a_radius;
  attribute float a_revealOrder;
  attribute float a_category;

  uniform vec4 u_plotArea;
  uniform vec2 u_xDomain;
  uniform vec2 u_yDomain;
  uniform vec2 u_canvasSize;
  uniform float u_globalRadius;
  uniform float u_devicePixelRatio;
  uniform vec4 u_resizeTransform;
  uniform float u_hasResizeTransform;
  uniform float u_revealProgress;
  uniform float u_revealEnabled;
  uniform float u_revealStagger;
  uniform float u_revealFade;
  uniform float u_revealGrow;
  uniform float u_revealFadeWindow;
  uniform vec4 u_color;
  uniform float u_shape;
  uniform float u_categoryEnabled;
  uniform float u_categoryCount;
  uniform vec4 u_categoryColors[${POINT_CLOUD_CATEGORY_STYLE_LIMIT}];
  uniform float u_categoryShapes[${POINT_CLOUD_CATEGORY_STYLE_LIMIT}];

  varying float v_pointSize;
  varying float v_revealAlpha;
  varying vec4 v_color;
  varying float v_shape;

  vec4 categoryColor(float category) {
    vec4 color = u_color;
    float wrapped = mod(category, ${POINT_CLOUD_CATEGORY_STYLE_LIMIT}.0);

    for (int i = 0; i < ${POINT_CLOUD_CATEGORY_STYLE_LIMIT}; i++) {
      if (abs(wrapped - float(i)) < 0.5) {
        color = u_categoryColors[i];
      }
    }

    return color;
  }

  float categoryShape(float category) {
    float shape = u_shape;
    float wrapped = mod(category, ${POINT_CLOUD_CATEGORY_STYLE_LIMIT}.0);

    for (int i = 0; i < ${POINT_CLOUD_CATEGORY_STYLE_LIMIT}; i++) {
      if (abs(wrapped - float(i)) < 0.5) {
        shape = u_categoryShapes[i];
      }
    }

    return shape;
  }

  float shapePointScale(float shape) {
    if (shape < 0.5) return 1.0;
    if (shape < 1.5) return 0.9;
    if (shape < 2.5) return 1.24;
    if (shape < 3.5) return 1.32;
    return 1.35;
  }

  void main() {
    v_revealAlpha = 1.0;
    v_color = u_categoryEnabled > 0.5 && u_categoryCount > 0.5 ? categoryColor(a_category) : u_color;
    v_shape = u_categoryEnabled > 0.5 && u_categoryCount > 0.5 ? categoryShape(a_category) : u_shape;

    if (u_revealEnabled > 0.5) {
      float revealStart = a_revealOrder * u_revealStagger;

      if (u_revealFade > 0.5 || u_revealGrow > 0.5) {
        float fadeSpan = min(u_revealFadeWindow, max(0.001, 1.0 - revealStart));
        float local = u_revealProgress - revealStart;
        if (local <= 0.0) {
          gl_Position = vec4(-10.0, -10.0, 0.0, 1.0);
          gl_PointSize = 0.0;
          v_revealAlpha = 0.0;
          return;
        }
        float t = smoothstep(0.0, 1.0, local / fadeSpan);
        if (u_revealFade > 0.5) {
          v_revealAlpha = t;
        }
      } else if (u_revealProgress < revealStart) {
        gl_Position = vec4(-10.0, -10.0, 0.0, 1.0);
        gl_PointSize = 0.0;
        return;
      }
    }

    float xSpan = u_xDomain.y - u_xDomain.x;
    float ySpan = u_yDomain.y - u_yDomain.x;

    if (
      xSpan <= 0.0 ||
      ySpan <= 0.0 ||
      a_position.x < u_xDomain.x ||
      a_position.x > u_xDomain.y ||
      a_position.y < u_yDomain.x ||
      a_position.y > u_yDomain.y
    ) {
      gl_Position = vec4(-10.0, -10.0, 0.0, 1.0);
      gl_PointSize = 0.0;
      v_pointSize = 0.0;
      v_revealAlpha = 0.0;
      return;
    }

    float pctX = (a_position.x - u_xDomain.x) / xSpan;
    float pctY = (a_position.y - u_yDomain.x) / ySpan;

    float screenX = u_plotArea.x + pctX * u_plotArea.z;
    float screenY = u_plotArea.y + u_plotArea.w - pctY * u_plotArea.w;

    if (u_hasResizeTransform > 0.5) {
      screenX = screenX * u_resizeTransform.x + u_resizeTransform.z;
      screenY = screenY * u_resizeTransform.y + u_resizeTransform.w;
    }

    float clipX = (screenX / u_canvasSize.x) * 2.0 - 1.0;
    float clipY = 1.0 - (screenY / u_canvasSize.y) * 2.0;

    gl_Position = vec4(clipX, clipY, 0.0, 1.0);

    float radius = a_radius > 0.0 ? a_radius : u_globalRadius;

    float revealSize = 1.0;
    if (u_revealEnabled > 0.5) {
      if (u_revealGrow > 0.5) {
        float revealStart = a_revealOrder * u_revealStagger;
        float fadeSpan = min(u_revealFadeWindow, max(0.001, 1.0 - revealStart));
        float local = u_revealProgress - revealStart;
        revealSize = local <= 0.0 ? 0.0 : smoothstep(0.0, 1.0, local / fadeSpan);
      } else if (u_revealFade > 0.5) {
        revealSize = mix(0.12, 1.0, v_revealAlpha);
      }
    }

    v_pointSize = max(1.0, radius * 2.0 * shapePointScale(v_shape) * u_devicePixelRatio * revealSize);
    gl_PointSize = v_pointSize;
  }
`;

export const POINT_CLOUD_FRAGMENT_SHADER = `
  precision mediump float;

  uniform float u_opacity;

  varying float v_pointSize;
  varying float v_revealAlpha;
  varying vec4 v_color;
  varying float v_shape;

  void main() {
    vec2 p = gl_PointCoord - vec2(0.5);
    float border = 1.0 / max(1.0, v_pointSize);
    float alpha = 1.0;

    if (v_shape < 0.5 && v_pointSize <= 2.0) {
      alpha = 1.0;
    } else if (v_shape < 0.5) {
      float dist = length(p);
      alpha = 1.0 - smoothstep(0.5 - border, 0.5, dist);
    } else if (v_shape < 1.5) {
      float edge = max(abs(p.x), abs(p.y));
      alpha = 1.0 - smoothstep(0.5 - border, 0.5, edge);
    } else if (v_shape < 2.5) {
      float edge = abs(p.x) + abs(p.y);
      alpha = 1.0 - smoothstep(0.5 - border, 0.5, edge);
    } else if (v_shape < 3.5) {
      float halfWidth = max(0.0, (p.y + 0.5) * 0.57735);
      float side = abs(p.x) - halfWidth;
      float bottom = p.y - 0.25;
      float top = -p.y - 0.5;
      float edge = max(max(side, bottom), top);
      alpha = 1.0 - smoothstep(-border, border, edge);
    } else if (v_shape < 4.5) {
      float theta = atan(p.y, p.x);
      float sector = 0.6283185;
      float normalized = mod(theta + 1.5707963 + 6.2831853, 6.2831853);
      float vertexIndex = floor(normalized / sector);
      float a0 = -1.5707963 + vertexIndex * sector;
      float a1 = a0 + sector;
      float outer = 0.5;
      float inner = 0.225;
      float r0 = mod(vertexIndex, 2.0) < 1.0 ? outer : inner;
      float r1 = mod(vertexIndex, 2.0) < 1.0 ? inner : outer;
      vec2 ray = vec2(cos(theta), sin(theta));
      vec2 v0 = vec2(cos(a0), sin(a0)) * r0;
      vec2 v1 = vec2(cos(a1), sin(a1)) * r1;
      vec2 edgeSegment = v1 - v0;
      float denominator = ray.x * edgeSegment.y - ray.y * edgeSegment.x;
      float limit = abs((v0.x * edgeSegment.y - v0.y * edgeSegment.x) / denominator);
      float edge = length(p) - limit;
      alpha = 1.0 - smoothstep(-border, border, edge);
    } else if (v_shape < 5.5) {
      float cross = min(
        1.0 - smoothstep(0.16 - border, 0.16 + border, abs(p.x)),
        1.0 - smoothstep(0.5 - border, 0.5 + border, abs(p.y))
      );
      float crossAlt = min(
        1.0 - smoothstep(0.5 - border, 0.5 + border, abs(p.x)),
        1.0 - smoothstep(0.16 - border, 0.16 + border, abs(p.y))
      );
      alpha = max(cross, crossAlt);
    } else if (v_shape < 6.5) {
      vec2 rp = vec2((p.x - p.y) * 0.7071068, (p.x + p.y) * 0.7071068);
      float cross = min(
        1.0 - smoothstep(0.16 - border, 0.16 + border, abs(rp.x)),
        1.0 - smoothstep(0.5 - border, 0.5 + border, abs(rp.y))
      );
      float crossAlt = min(
        1.0 - smoothstep(0.5 - border, 0.5 + border, abs(rp.x)),
        1.0 - smoothstep(0.16 - border, 0.16 + border, abs(rp.y))
      );
      alpha = max(cross, crossAlt);
    } else {
      float angle = atan(p.y, p.x) + 1.5707963;
      float sector = 1.2566371;
      float local = mod(angle + sector * 0.5, sector) - sector * 0.5;
      float edge = length(p) * cos(local) - 0.42;
      alpha = 1.0 - smoothstep(-border, border, edge);
    }

    if (alpha <= 0.0) {
      discard;
    }

    float finalAlpha = v_color.a * u_opacity * alpha * v_revealAlpha;
    gl_FragColor = vec4(v_color.rgb * finalAlpha, finalAlpha);
  }
`;
