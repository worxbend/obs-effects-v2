/**
 * The shared webcam input: one `MediaStream` for the page, handed out as a texture per consumer.
 *
 * ## The line this file draws, which is the whole design
 *
 * **The stream is shared. The texture is not.**
 *
 * Sharing the stream is what stops two camera-framing effects from contending for the device, for
 * exactly the reasons set out in `./audio.ts`. But a `THREE.VideoTexture` belongs to one WebGL
 * context and a `PIXI.Texture` to one renderer, so handing the same texture to two effects would be
 * a cross-context bug: the second effect would upload into a context that is not its own, and the
 * symptom is a black or corrupted rectangle that depends on which effect mounted first.
 *
 * So each consumer mints its own texture from the shared element, into its own scope, with
 * {@link videoTextureThree} or {@link videoTexturePixi}.
 *
 * ## No effect uses this yet, and that is why now is the moment to build it
 *
 * `camera-frame-ring` is a torus overlay — it is *for* framing a webcam but it never touches one.
 * This file therefore has no existing behaviour to preserve, which makes it the cheapest it will
 * ever be to get its shape right, before the camera-framing batch of effects depends on it.
 *
 * ## The placeholder
 *
 * With no camera permission (the normal state of an OBS browser source) the resource still resolves,
 * with `kind: "placeholder"`: a small canvas painted with a slowly drifting gradient and a centre
 * marker, published as a real `MediaStream` through `canvas.captureStream()`. An effect therefore
 * gets a video element that is genuinely playing, with sensible dimensions, and needs no branch —
 * the same trick `./audio.ts` plays with its simulated spectrum, for the same reason.
 */

import * as PIXI from "pixi.js";
import * as THREE from "three";

import type { Scope } from "./scope";
import { createSharedResource, type SharedResource } from "./lease";

/** Size and frame rate of the placeholder pattern. Small on purpose: nobody is meant to admire it. */
const PLACEHOLDER_WIDTH = 640;
const PLACEHOLDER_HEIGHT = 360;
const PLACEHOLDER_FPS = 15;

/** A playing video element plus what a consumer needs to know about it. */
export interface VideoSource {
  /**
   * The shared, already-playing `<video>` element. It is not in the document — it exists only to be
   * uploaded to the GPU.
   *
   * Never pause it, never change its `srcObject`, and never append it anywhere: other effects are
   * reading the same element.
   */
  readonly element: HTMLVideoElement;
  /** Frame width in pixels. Falls back to the placeholder size before the first frame arrives. */
  readonly width: number;
  /** Frame height in pixels. */
  readonly height: number;
  /** `"camera"` when a real device is delivering frames; `"placeholder"` when it is the test pattern. */
  readonly kind: "camera" | "placeholder";
}

/** Everything one page-wide video source owns, so `destroy` can take it all down. */
interface VideoGraph {
  source: VideoSource;
  element: HTMLVideoElement;
  stream: MediaStream;
  /** Non-null only for the placeholder: the interval that repaints its canvas. */
  painter: ReturnType<typeof setInterval> | null;
}

/** Paints the placeholder pattern and publishes it as a stream. Used when there is no camera. */
function createPlaceholderStream(): {
  stream: MediaStream;
  painter: ReturnType<typeof setInterval>;
} {
  const canvas = document.createElement("canvas");
  canvas.width = PLACEHOLDER_WIDTH;
  canvas.height = PLACEHOLDER_HEIGHT;
  const context = canvas.getContext("2d");

  let phase = 0;
  const paint = (): void => {
    if (!context) return;
    phase += 1 / PLACEHOLDER_FPS;
    const gradient = context.createLinearGradient(0, 0, canvas.width, canvas.height);
    const shift = (Math.sin(phase * 0.6) + 1) / 2;
    gradient.addColorStop(0, `hsl(${200 + shift * 60}, 45%, 18%)`);
    gradient.addColorStop(1, `hsl(${300 + shift * 40}, 45%, 30%)`);
    context.fillStyle = gradient;
    context.fillRect(0, 0, canvas.width, canvas.height);

    // A centre marker, so an effect that maps the texture onto geometry can see at a glance whether
    // its UV coordinates are the right way up.
    context.strokeStyle = "rgba(255,255,255,0.35)";
    context.lineWidth = 3;
    context.beginPath();
    context.arc(canvas.width / 2, canvas.height / 2, 60 + shift * 10, 0, Math.PI * 2);
    context.stroke();
  };
  paint();

  const painter = setInterval(paint, 1000 / PLACEHOLDER_FPS);
  return { stream: canvas.captureStream(PLACEHOLDER_FPS), painter };
}

/** Builds the graph. Never rejects: no camera means the placeholder pattern. */
async function createGraph(): Promise<VideoGraph> {
  let stream: MediaStream | null = null;
  let painter: ReturnType<typeof setInterval> | null = null;
  let kind: VideoSource["kind"] = "camera";

  try {
    if (navigator.mediaDevices?.getUserMedia) {
      stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
    }
  } catch {
    stream = null;
  }

  if (!stream) {
    const placeholder = createPlaceholderStream();
    stream = placeholder.stream;
    painter = placeholder.painter;
    kind = "placeholder";
  }

  const element = document.createElement("video");
  element.srcObject = stream;
  // `playsInline` and `muted` together are what let a video element start playing with no user
  // gesture. Without `muted`, autoplay is blocked and the element sits on its first frame forever.
  element.playsInline = true;
  element.muted = true;
  element.autoplay = true;
  await element.play().catch(() => undefined);

  const source: VideoSource = {
    element,
    get width(): number {
      return element.videoWidth || PLACEHOLDER_WIDTH;
    },
    get height(): number {
      return element.videoHeight || PLACEHOLDER_HEIGHT;
    },
    kind,
  };

  return { source, element, stream, painter };
}

/**
 * The page's single video source, refcounted.
 *
 * Exported for the verification harness. Effects use {@link useVideo}.
 */
export const videoResource: SharedResource<VideoGraph> = createSharedResource<VideoGraph>({
  label: "video",
  create: createGraph,
  destroy(graph: VideoGraph): void {
    if (graph.painter !== null) clearInterval(graph.painter);
    graph.element.pause();
    graph.element.srcObject = null;
    // Stopping every track is what actually turns the camera light off. Dropping the reference
    // does not: the stream stays live until it is collected, which may be minutes.
    graph.stream.getTracks().forEach((track) => track.stop());
  },
});

/**
 * Acquires the page's video source for as long as `scope` is alive.
 *
 * **It never rejects.** With no camera it resolves to the placeholder pattern, so an effect needs no
 * fallback branch of its own. Check `source.kind` only if you want to say so on screen.
 *
 * **It does not checkpoint for you** either — see the same note on `useAudio`. Opening a camera can
 * take seconds, so put a `scope.checkpoint()` on the line after the `await`.
 */
export async function useVideo(scope: Scope): Promise<VideoSource> {
  const lease = await videoResource.acquire(scope);
  return lease.value.source;
}

/**
 * Mints a `THREE.VideoTexture` for this effect, owned by `scope`.
 *
 * **Never share the returned texture between effects.** A texture belongs to the WebGL context that
 * uploaded it; see this file's header.
 *
 * The texture updates itself from the video element every frame three.js draws — there is no
 * `texture.needsUpdate = true` to remember, which is the one thing `VideoTexture` adds over a plain
 * `Texture`.
 */
export function videoTextureThree(scope: Scope, source: VideoSource): THREE.VideoTexture {
  const texture = new THREE.VideoTexture(source.element);
  texture.colorSpace = THREE.SRGBColorSpace;
  // Video frames are not power-of-two sized and have no mipmaps, so linear filtering with clamped
  // edges is the only combination that is correct everywhere.
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  return scope.ownDisposable(texture);
}

/**
 * Mints a `PIXI.Texture` for this effect, owned by `scope`.
 *
 * **Never share the returned texture between effects** — see this file's header.
 *
 * Pixi drives its own upload from the video element, so the sprite using this keeps moving with no
 * per-frame work from the effect.
 */
export function videoTexturePixi(scope: Scope, source: VideoSource): PIXI.Texture {
  const pixiSource = new PIXI.VideoSource({ resource: source.element, autoPlay: true });
  const texture = new PIXI.Texture({ source: pixiSource });
  scope.defer(() => {
    // `destroy(true)` on the texture also destroys the source it wraps, which is what releases the
    // GPU upload. The shared <video> element itself belongs to the lease, not to this texture.
    texture.destroy(true);
  });
  return texture;
}
