/**
 * SkSL fragment shader for the ambient visual layer.
 *
 * Uses domain-warped noise fields to produce organic flowing shapes.
 * Parameters map directly to the five abstract ambient parameters:
 *   density    → shape complexity / frequency of the noise field
 *   mood       → hue rotation (cool blue ↔ warm amber)
 *   brightness → overall luminosity and contrast
 *   texture    → warp strength / grain intensity
 *   speed      → (fed through the `time` uniform which ticks faster/slower)
 *
 * The shader is pure math — no textures required.
 */
export const FLOW_FIELD_SHADER = /* glsl */ `
uniform float time;
uniform float density;
uniform float mood;
uniform float brightness;
uniform float texture;
uniform vec2  resolution;

// ---- Noise helpers ----

float hash(vec2 p) {
  p = fract(p * vec2(127.1, 311.7));
  p += dot(p, p + 19.19);
  return fract(p.x * p.y);
}

float valueNoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f); // smoothstep

  float a = hash(i);
  float b = hash(i + vec2(1.0, 0.0));
  float c = hash(i + vec2(0.0, 1.0));
  float d = hash(i + vec2(1.0, 1.0));

  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

float fbm3(vec2 p) {
  float v = 0.0;
  float a = 0.5;
  vec2  shift = vec2(100.0);
  for (int i = 0; i < 3; i++) {
    v += a * valueNoise(p);
    p = p * 2.0 + shift;
    a *= 0.5;
  }
  return v;
}

float fbm4(vec2 p) {
  float v = 0.0;
  float a = 0.5;
  vec2  shift = vec2(100.0);
  for (int i = 0; i < 4; i++) {
    v += a * valueNoise(p);
    p = p * 2.0 + shift;
    a *= 0.5;
  }
  return v;
}

// ---- Domain warp ----

vec2 warp(vec2 p) {
  float t = time * 0.15;
  float warpScale = texture * 1.8 + 0.2;
  float ox = fbm3(p + vec2(t,       0.3));
  float oy = fbm3(p + vec2(t + 3.7, 1.7));
  return p + vec2(ox, oy) * warpScale;
}

// ---- Main ----

half4 main(vec2 fragCoord) {
  vec2 uv = fragCoord / resolution;
  // Keep aspect ratio
  uv.x *= resolution.x / resolution.y;

  // Scale by density (more detail = higher density)
  float scale = 1.5 + density * 3.0;
  vec2  p     = uv * scale;

  // Two-pass domain warp for organic feel
  vec2 q = warp(p);
  vec2 r = warp(q + vec2(time * 0.05, 0.0));

  // Main luminance field
  float n1 = fbm4(r);
  float n2 = fbm3(r + vec2(1.7, 9.2));
  float field = n1 * 0.7 + n2 * 0.3;

  // Edge enhancement: light bands along the flow gradient
  float bands = sin(field * 12.0 + time * 0.2) * 0.5 + 0.5;
  float lum = mix(field, bands, 0.3);
  lum = clamp(lum * (0.4 + brightness * 1.2), 0.0, 1.0);
  // Gamma and contrast
  lum = pow(lum, 0.5 + (1.0 - brightness) * 0.8);

  // Colour: cool blue → warm amber via mood
  vec3 cool = vec3(0.08, 0.15, 0.45);
  vec3 mid  = vec3(0.05, 0.30, 0.35);
  vec3 warm = vec3(0.55, 0.25, 0.05);
  vec3 base = mood < 0.5
    ? mix(cool, mid,  mood * 2.0)
    : mix(mid,  warm, (mood - 0.5) * 2.0);

  // Secondary accent colour (complementary)
  vec3 accent = vec3(0.6, 0.1, 0.5) * (1.0 - mood);

  vec3 colour = base * lum + accent * n2 * 0.15 * brightness;

  // Subtle vignette
  vec2  vig = (fragCoord / resolution) - 0.5;
  float vignette = 1.0 - dot(vig, vig) * 1.2;
  colour *= clamp(vignette, 0.0, 1.0);

  return half4(colour, 1.0);
}
`;
