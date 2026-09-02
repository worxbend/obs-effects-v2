import type { EffectModule } from "./types";

import starfieldWarp from "./three/starfield-warp";
import plasmaShader from "./three/plasma-shader";
import cameraFrameRing from "./three/camera-frame-ring";
import particleDrift from "./pixi/particle-drift";
import digitalRain from "./pixi/digital-rain";
import audioBars from "./pixi/audio-bars";

// Ported from the old `obs-effects` repository — see each file's header for what it was and what
// changed. They keep their original look; every constant they hard-coded is now a parameter.
import razerToxicMarble from "./three/razer-toxic-marble";
import toxicMarbleDots from "./pixi/toxic-marble-dots";
import toxicDevTerminal from "./pixi/toxic-dev-terminal";
import toxicDevCorrupt from "./pixi/toxic-dev-corrupt";
import redCorrupt from "./pixi/red-corrupt";
import amberTerminal from "./pixi/amber-terminal";
import glitchTerminalEffect from "./pixi/glitch-terminal";
import audioWaveformRazer from "./pixi/audio-waveform-razer";
import audioWaveformRazerPrism from "./pixi/audio-waveform-razer-prism";
import audioWaveformRazerSpectrum from "./pixi/audio-waveform-razer-spectrum";
import audioWaveformRazerWeave from "./pixi/audio-waveform-razer-weave";
import audioWaveformRazerHelix from "./pixi/audio-waveform-razer-helix";
import audioWaveformRazerRibbons from "./pixi/audio-waveform-razer-ribbons";
import audioWaveformRazerRibbonBands from "./pixi/audio-waveform-razer-ribbon-bands";
import audioWaveformRazerRibbonLattice from "./pixi/audio-waveform-razer-ribbon-lattice";
import razerBgCoding from "./pixi/razer-bg-coding";
import razerBgGaming from "./three/razer-bg-gaming";
import razerBgTalking from "./three/razer-bg-talking";
import razerCamBorderRect from "./three/razer-cam-border-rect";
import razerCamBorderRhombic from "./three/razer-cam-border-rhombic";
import razerCamBorderFluid from "./three/razer-cam-border-fluid";
import razerAudioCamBorder from "./three/razer-audio-cam-border";
import razerScreenShareBorder from "./three/razer-screen-share-border";
import razerDiagonalStreaks from "./pixi/razer-diagonal-streaks";
import razerHalftoneFade from "./pixi/razer-halftone-fade";
import razerAetherDrift from "./three/razer-aether-drift";
import razerCornerAccents from "./pixi/razer-corner-accents";
import razerStatusLine from "./pixi/razer-status-line";
import razerLogoMark from "./pixi/razer-logo-mark";
import inkDissolveRazer from "./three/ink-dissolve-razer";
import glitchVeil from "./pixi/glitch-veil";
import dataCorruption from "./pixi/data-corruption";
import glitchApe from "./three/glitch-ape";
import hologramGlitch from "./three/hologram-glitch";
import glitchOverlay from "./pixi/glitch-overlay";
import starField from "./pixi/star-field";
import animatedLines from "./pixi/animated-lines";
import catMesh from "./pixi/cat-mesh";
import logo from "./pixi/logo";
import startingSoonFluid from "./pixi/starting-soon-fluid";
import jellyText3d from "./three/jelly-text-3d";
import particleText from "./pixi/particle-text";
import emberPentagramOverlay from "./pixi/ember-pentagram-overlay";
import proceduralLogo from "./pixi/procedural-logo";
import mainWebCamBorder from "./pixi/main-web-cam-border";
import screenCaptureBorder from "./pixi/screen-capture-border";
import floatingDust from "./pixi/floating-dust";
import rainOnGlass from "./three/rain-on-glass";
import waveSimulation from "./pixi/wave-simulation";
import molecularText from "./pixi/molecular-text";
import fluidText from "./pixi/fluid-text";
import topography from "./pixi/topography";

// Original effects written for this project (not ports).
import circularCamPulse from "./pixi/circular-cam-pulse";
import fluidRingCam from "./three/fluid-ring-cam";
import gradientFrame from "./pixi/gradient-frame";

// Chat overlays — driven by the Twitch chat feed via the SDK's `useChat`. The two `chat-typing` /
// `chat-pixel-text` files are originals; the rest are ports of the `twitch-vizer` scenes.
import chatTyping from "./pixi/chat-typing";
import chatPixelText from "./pixi/chat-pixel-text";
import chatCards from "./pixi/chat-cards";
import pixelChat from "./pixi/pixel-chat";
import emojiChat from "./pixi/emoji-chat";
import fluidChat from "./pixi/fluid-chat";
import hackerChatCards from "./pixi/hacker-chat-cards";
import chatStatusLine from "./pixi/chat-status-line";
import glitchBurst from "./pixi/glitch-burst";
import mrRobotCrt from "./pixi/mr-robot-crt";
import grungeFilm from "./pixi/grunge-film";
import piedPiperNet from "./pixi/pied-piper-net";
import chatSound from "./pixi/chat-sound";
import soundboard from "./pixi/soundboard";

/**
 * The effect inventory.
 *
 * This array is the single source of truth for "which effects does this build of the frontend
 * know how to draw". Two things consume it:
 *
 *  1. The renderer page (`/e/:slug`) looks up an effect by `descriptor.id` when a route says which
 *     effect to mount.
 *  2. At startup the app posts every `descriptor` in this list to `POST /api/effects/sync`, which
 *     replaces the backend's stored inventory wholesale. That is how the admin UI learns about a
 *     new effect: you add one line here, the backend is told on the next page load, and the effect
 *     appears in the dropdown. Nothing else needs editing.
 *
 * Because the sync is a full replacement, an effect removed from this list disappears from the
 * admin UI too — so add and remove entries deliberately.
 */
export const effects: EffectModule[] = [
  starfieldWarp,
  plasmaShader,
  cameraFrameRing,
  particleDrift,
  digitalRain,
  audioBars,
  razerToxicMarble,
  toxicMarbleDots,
  toxicDevTerminal,
  toxicDevCorrupt,
  redCorrupt,
  amberTerminal,
  glitchTerminalEffect,
  audioWaveformRazer,
  audioWaveformRazerPrism,
  audioWaveformRazerSpectrum,
  audioWaveformRazerWeave,
  audioWaveformRazerHelix,
  audioWaveformRazerRibbons,
  audioWaveformRazerRibbonBands,
  audioWaveformRazerRibbonLattice,
  razerBgCoding,
  razerBgGaming,
  razerBgTalking,
  razerCamBorderRect,
  razerCamBorderRhombic,
  razerCamBorderFluid,
  razerAudioCamBorder,
  razerScreenShareBorder,
  razerDiagonalStreaks,
  razerHalftoneFade,
  razerAetherDrift,
  razerCornerAccents,
  razerStatusLine,
  razerLogoMark,
  inkDissolveRazer,
  glitchVeil,
  dataCorruption,
  glitchApe,
  hologramGlitch,
  glitchOverlay,
  starField,
  animatedLines,
  catMesh,
  logo,
  startingSoonFluid,
  jellyText3d,
  particleText,
  emberPentagramOverlay,
  proceduralLogo,
  mainWebCamBorder,
  screenCaptureBorder,
  floatingDust,
  rainOnGlass,
  waveSimulation,
  molecularText,
  fluidText,
  topography,
  circularCamPulse,
  fluidRingCam,
  gradientFrame,
  chatTyping,
  chatPixelText,
  chatCards,
  pixelChat,
  emojiChat,
  fluidChat,
  hackerChatCards,
  chatStatusLine,
  glitchBurst,
  mrRobotCrt,
  grungeFilm,
  piedPiperNet,
  chatSound,
  soundboard,
];

export {
  starfieldWarp,
  plasmaShader,
  cameraFrameRing,
  particleDrift,
  digitalRain,
  audioBars,
  razerToxicMarble,
  toxicMarbleDots,
  toxicDevTerminal,
  toxicDevCorrupt,
  redCorrupt,
  amberTerminal,
  glitchTerminalEffect,
  audioWaveformRazer,
  audioWaveformRazerPrism,
  audioWaveformRazerSpectrum,
  audioWaveformRazerWeave,
  audioWaveformRazerHelix,
  audioWaveformRazerRibbons,
  audioWaveformRazerRibbonBands,
  audioWaveformRazerRibbonLattice,
  razerBgCoding,
  razerBgGaming,
  razerBgTalking,
  razerCamBorderRect,
  razerCamBorderRhombic,
  razerCamBorderFluid,
  razerAudioCamBorder,
  razerScreenShareBorder,
  razerDiagonalStreaks,
  razerHalftoneFade,
  razerAetherDrift,
  razerCornerAccents,
  razerStatusLine,
  razerLogoMark,
  inkDissolveRazer,
  glitchVeil,
  dataCorruption,
  glitchApe,
  hologramGlitch,
  glitchOverlay,
  starField,
  animatedLines,
  catMesh,
  logo,
  startingSoonFluid,
  jellyText3d,
  particleText,
  emberPentagramOverlay,
  proceduralLogo,
  mainWebCamBorder,
  screenCaptureBorder,
  floatingDust,
  rainOnGlass,
  waveSimulation,
  molecularText,
  fluidText,
  topography,
  circularCamPulse,
  fluidRingCam,
  gradientFrame,
  chatTyping,
  chatPixelText,
  chatCards,
  pixelChat,
  emojiChat,
  fluidChat,
  hackerChatCards,
  chatStatusLine,
  glitchBurst,
  mrRobotCrt,
  grungeFilm,
  piedPiperNet,
  chatSound,
  soundboard,
};
