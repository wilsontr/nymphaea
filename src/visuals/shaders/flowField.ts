/**
 * FLOW_FIELD_SHADER (SkSL fragment shader)
 *
 * What it does:
 * - Renders a full-screen, procedural "ambient flow" image with no textures.
 * - Produces soft organic structures by combining fractal noise (fBm) with
 *   domain warping (noise used to distort noise coordinates).
 * - Maps the app's five high-level ambient controls to visual behavior.
 *
 * Uniforms:
 * - time: animation phase in seconds (or a scaled clock); drives motion.
 * - density: spatial frequency/detail. Higher = tighter, more complex forms.
 * - mood: color interpolation from cool blue -> teal -> warm amber.
 * - brightness: luminance gain + gamma/contrast shaping.
 * - texture: warp intensity (how strongly coordinates are bent/distorted).
 * - resolution: viewport size in pixels; used for normalization and aspect.
 *
 * How it works (pipeline):
 * 1) Normalize pixel coordinates (fragCoord / resolution), then fix aspect ratio.
 * 2) Scale UV space by density to control feature size.
 * 3) Apply two-pass domain warp:
 *    - warp(p) offsets coordinates using low-octave fBm fields (ox, oy).
 *    - second pass warps the already-warped point for richer flow structure.
 * 4) Build luminance field from mixed fBm layers:
 *    - n1 = fbm4(r), n2 = fbm3(r + offset), field = 0.7*n1 + 0.3*n2.
 * 5) Add gentle banding via sin(field * k + time * w) and mix with field.
 * 6) Apply brightness-dependent gain + gamma curve.
 * 7) Compute palette by mood (cool/mid/warm), then add a subtle accent term.
 * 8) Apply vignette falloff toward edges and output opaque color.
 *
 * Notes:
 * - valueNoise is deterministic hash-based value noise (no texture lookups).
 * - fbm3/fbm4 are octave stacks trading detail vs cost.
 * - Shader is intentionally branch-light and texture-free for mobile stability.
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
  float warpScale = texture * 2.8 + 0.1;
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
  float scale = 1.5 + density * 5.0;
  vec2  p     = uv * scale;

  // Two-pass domain warp for organic feel
  vec2 q = warp(p);
  vec2 r = warp(q + vec2(time * 0.01, 0.0));

  // Main luminance field
  float n1 = fbm4(r);
  float n2 = fbm3(r + vec2(1.7, 9.2));
  float micro = valueNoise(r * 7.5 + vec2(time * 0.08, -time * 0.05));
  float field = n1 * 0.62 + n2 * 0.28 + micro * 0.10;
  field = clamp(field, 0.0, 1.0);

  // Edge enhancement: light bands along the flow gradient
  float bands = sin(field * 11.0 + time * 2.0) * 0.5 + 0.5;
  float lum = mix(field, bands, 0.14);
  // Preserve highlights by avoiding an early hard clamp on luminance.
  lum = max(lum, 0.0);
  float gain = mix(0.55, 2.4, brightness);
  float gamma = mix(1.4, 0.75, brightness);
  lum = pow(lum, gamma) * gain;

  // Colour: cool blue → warm amber via mood
  vec3 cool = vec3(0.18, 0.25, 0.55);
  vec3 mid  = vec3(0.05, 0.30, 0.35);
  vec3 warm = vec3(0.5, 0.25, 0.05);
  vec3 base = mood < 0.5
    ? mix(cool, mid,  mood * 3.0)
    : mix(mid,  warm, (mood - 0.5) * 2.0);

  // Secondary accent colour (complementary)
  vec3 accent = vec3(0.7, 0.2, 0.5) * (1.0 - mood);

  vec3 colour = base * lum + accent * n2 * 0.15 * brightness;
  // Soft shoulder tone mapping: wider apparent range without harsh clipping.
  colour = 1.0 - exp(-colour);

  // Subtle vignette
  vec2  vig = (fragCoord / resolution) - 0.5;
  float vignette = 1.0 - dot(vig, vig) * 1.2;
  colour *= clamp(vignette, 0.0, 1.0);

  return half4(colour, 1.0);
}
`;
