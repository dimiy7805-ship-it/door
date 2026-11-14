import React, { useEffect, useRef } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import {
  BRAND_SPECS,
  IntercomBrand,
  RemoteRotationMode,
  formatRotationLabel,
  resolveEffectiveRotation,
} from '../utils/intercomLogic';

export interface IntercomScene3DProps {
  brand: IntercomBrand;
  displayText: string;
  pressedKeyTrigger: { key: string; seq: number } | null;
  onKeyPress: (label: string) => void;
  remoteVideoCanvasRef?: React.RefObject<HTMLCanvasElement | null>;
  localVideoElementRef?: React.RefObject<HTMLVideoElement | null>;
  remoteVideoElementRef?: React.RefObject<HTMLVideoElement | null>;
  remoteFrameSeq?: number;
  isCallConnected?: boolean;
  peerPin?: string | null;
  myPin?: string;
  camEnabled?: boolean;
  micEnabled?: boolean;
  peerMicEnabled?: boolean;
  peerCamEnabled?: boolean;
  mirrorLocalVideo?: boolean;
  showSelfPreview?: boolean;
  onToggleSelfPreview?: () => void;
  remoteRotation?: RemoteRotationMode;
  baselinePeerIsPortrait?: boolean | null;
  onRotateRemoteVideo?: () => void;
  isNightMode?: boolean;
}

const KEY_LABELS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', 'C', '0', 'B'];

interface TactileSurfaceMaps {
  colorMap: THREE.CanvasTexture;
  bumpMap: THREE.CanvasTexture;
  dispose: () => void;
}

/**
 * Generates realistic tactile surface textures:
 * - 'powder': fine powder-coat stipple ("мелкая порошковая шагрень") for ELTIS
 * - 'satin-metallic': directional micro-bead-blasted champagne-copper metallic satin for VIZIT
 * - 'hammered': coarse hammered cellular enamel ("крупная молотковая/кратерная шагрень") for CYFRAL
 * - 'cast': sandblasted cast-aluminum texture for outer frame and inserts
 */
function createTactileSurfaceMaps(
  style: 'powder' | 'satin-metallic' | 'hammered' | 'cast',
  baseHex: number,
  maxAnisotropy: number
): TactileSurfaceMaps {
  const size = 256;
  const colorCanvas = document.createElement('canvas');
  colorCanvas.width = size;
  colorCanvas.height = size;
  const cCtx = colorCanvas.getContext('2d')!;

  const bumpCanvas = document.createElement('canvas');
  bumpCanvas.width = size;
  bumpCanvas.height = size;
  const bCtx = bumpCanvas.getContext('2d')!;

  const baseColor = new THREE.Color(baseHex);
  const rBase = Math.round(baseColor.r * 255);
  const gBase = Math.round(baseColor.g * 255);
  const bBase = Math.round(baseColor.b * 255);

  if (style === 'satin-metallic') {
    const cImg = cCtx.createImageData(size, size);
    const bImg = bCtx.createImageData(size, size);
    let seed = 2029;
    const rand = () => {
      seed = (seed * 16807) % 2147483647;
      return (seed & 0xffff) / 0xffff;
    };

    for (let y = 0; y < size; y++) {
      const streak = (rand() - 0.5) * 6;
      for (let x = 0; x < size; x++) {
        const idx = (y * size + x) * 4;
        const flake = (rand() + rand() - 1.0) * 18 + streak;
        cImg.data[idx] = Math.min(255, Math.max(0, Math.round(rBase + flake * 1.05)));
        cImg.data[idx + 1] = Math.min(255, Math.max(0, Math.round(gBase + flake * 0.95)));
        cImg.data[idx + 2] = Math.min(255, Math.max(0, Math.round(bBase + flake * 0.85)));
        cImg.data[idx + 3] = 255;

        const bVal = Math.min(255, Math.max(0, Math.round(128 + flake * 3.2)));
        bImg.data[idx] = bVal;
        bImg.data[idx + 1] = bVal;
        bImg.data[idx + 2] = bVal;
        bImg.data[idx + 3] = 255;
      }
    }
    cCtx.putImageData(cImg, 0, 0);
    bCtx.putImageData(bImg, 0, 0);

    for (let i = 0; i < 650; i++) {
      const x = rand() * size;
      const y = rand() * size;
      const bright = rand() > 0.45;
      const shift = bright ? 14 : -12;
      cCtx.fillStyle = `rgba(${Math.min(255, Math.max(0, rBase + shift))},${Math.min(
        255,
        Math.max(0, gBase + shift)
      )},${Math.min(255, Math.max(0, bBase + shift))},0.45)`;
      cCtx.fillRect(x, y, 1.5, 1.5);

      bCtx.fillStyle = bright ? 'rgba(220,220,220,0.55)' : 'rgba(40,40,40,0.55)';
      bCtx.fillRect(x, y, 1.5, 1.5);
    }
  } else if (style === 'hammered') {
    // Distinct 3rd surface texture for CYFRAL: true 3D micro-faceted cast bronze-umber relief
    // Built from a continuous multi-scale heightfield H(x,y) -> directional normal shading (dH/dx, dH/dy)
    // so every micro-ridge has physical top-right specular catch and bottom-left shadow depth (never flat!).
    const cImg = cCtx.createImageData(size, size);
    const bImg = bCtx.createImageData(size, size);
    let seed = 5507;
    const rand = () => {
      seed = (seed * 16807) % 2147483647;
      return (seed & 0xffff) / 0xffff;
    };

    const rawH = new Float32Array(size * size);
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        // Multi-frequency isotropic micro-crystalline wave + fine random height
        const w1 = Math.sin(x * 0.42 + y * 0.38) * Math.cos(y * 0.46 - x * 0.34);
        const w2 = Math.sin(x * 0.95 - y * 0.72) * Math.cos(x * 0.68 + y * 0.88);
        rawH[y * size + x] = (rand() - 0.5) * 1.6 + w1 * 0.65 + w2 * 0.45;
      }
    }

    // 3x3 box-filter pass to form cohesive ~1.8px micro-pebble facets with real slopes
    const smoothH = new Float32Array(size * size);
    for (let y = 0; y < size; y++) {
      const ym = (y - 1 + size) % size;
      const yp = (y + 1) % size;
      for (let x = 0; x < size; x++) {
        const xm = (x - 1 + size) % size;
        const xp = (x + 1) % size;
        smoothH[y * size + x] =
          rawH[y * size + x] * 0.36 +
          (rawH[y * size + xm] + rawH[y * size + xp] + rawH[ym * size + x] + rawH[yp * size + x]) *
            0.11 +
          (rawH[ym * size + xm] +
            rawH[ym * size + xp] +
            rawH[yp * size + xm] +
            rawH[yp * size + xp]) *
            0.05;
      }
    }

    for (let y = 0; y < size; y++) {
      const ym = (y - 1 + size) % size;
      const yp = (y + 1) % size;
      for (let x = 0; x < size; x++) {
        const xm = (x - 1 + size) % size;
        const xp = (x + 1) % size;
        const idx = (y * size + x) * 4;
        const hVal = smoothH[y * size + x];
        // Surface gradient (dH/dx, dH/dy) lit from upper-right key light (0.68, -0.73)
        const dhdx = smoothH[y * size + xp] - smoothH[y * size + xm];
        const dhdy = smoothH[yp * size + x] - smoothH[ym * size + x];
        const slopeShade = (-dhdx * 0.68 + dhdy * 0.73) * 24 + hVal * 5;

        cImg.data[idx] = Math.min(255, Math.max(0, Math.round(rBase + slopeShade * 1.12)));
        cImg.data[idx + 1] = Math.min(255, Math.max(0, Math.round(gBase + slopeShade * 0.98)));
        cImg.data[idx + 2] = Math.min(255, Math.max(0, Math.round(bBase + slopeShade * 0.86)));
        cImg.data[idx + 3] = 255;

        const bVal = Math.min(255, Math.max(0, Math.round(128 + hVal * 72 + (-dhdx + dhdy) * 18)));
        bImg.data[idx] = bVal;
        bImg.data[idx + 1] = bVal;
        bImg.data[idx + 2] = bVal;
        bImg.data[idx + 3] = 255;
      }
    }
    cCtx.putImageData(cImg, 0, 0);
    bCtx.putImageData(bImg, 0, 0);
  } else {
    const cImg = cCtx.createImageData(size, size);
    const bImg = bCtx.createImageData(size, size);
    let seed = style === 'powder' ? 1337 : 7919;
    const rand = () => {
      seed = (seed * 16807) % 2147483647;
      return (seed & 0xffff) / 0xffff;
    };

    const spread = style === 'powder' ? 28 : 20;
    for (let i = 0; i < cImg.data.length; i += 4) {
      const n = (rand() - 0.5) * spread;
      cImg.data[i] = Math.min(255, Math.max(0, Math.round(rBase + n)));
      cImg.data[i + 1] = Math.min(255, Math.max(0, Math.round(gBase + n)));
      cImg.data[i + 2] = Math.min(255, Math.max(0, Math.round(bBase + n)));
      cImg.data[i + 3] = 255;

      const bVal = Math.min(255, Math.max(0, Math.round(128 + n * 2.8)));
      bImg.data[i] = bVal;
      bImg.data[i + 1] = bVal;
      bImg.data[i + 2] = bVal;
      bImg.data[i + 3] = 255;
    }
    cCtx.putImageData(cImg, 0, 0);
    bCtx.putImageData(bImg, 0, 0);

    const noduleCount = style === 'powder' ? 900 : 500;
    for (let i = 0; i < noduleCount; i++) {
      const x = rand() * size;
      const y = rand() * size;
      const rad = style === 'powder' ? 1.1 + rand() * 1.9 : 0.9 + rand() * 1.4;
      const bright = rand() > 0.48;
      const shift = bright ? 14 : -14;
      cCtx.fillStyle = `rgba(${Math.min(255, Math.max(0, rBase + shift))},${Math.min(
        255,
        Math.max(0, gBase + shift)
      )},${Math.min(255, Math.max(0, bBase + shift))},0.5)`;
      cCtx.beginPath();
      cCtx.arc(x, y, rad, 0, Math.PI * 2);
      cCtx.fill();

      bCtx.fillStyle = bright ? 'rgba(230,230,230,0.6)' : 'rgba(30,30,30,0.6)';
      cCtx.beginPath();
      bCtx.beginPath();
      bCtx.arc(x, y, rad, 0, Math.PI * 2);
      bCtx.fill();
    }
  }

  const colorMap = new THREE.CanvasTexture(colorCanvas);
  colorMap.colorSpace = THREE.SRGBColorSpace;
  colorMap.wrapS = THREE.RepeatWrapping;
  colorMap.wrapT = THREE.RepeatWrapping;
  const repX = style === 'satin-metallic' ? 4.0 : style === 'hammered' ? 5.5 : 3.5;
  const repY = style === 'satin-metallic' ? 6.0 : style === 'hammered' ? 8.5 : 5.5;
  colorMap.repeat.set(repX, repY);
  colorMap.anisotropy = maxAnisotropy;
  if (maxAnisotropy === 1) {
    colorMap.generateMipmaps = false;
    colorMap.minFilter = THREE.LinearFilter;
  }

  const bumpMap = new THREE.CanvasTexture(bumpCanvas);
  bumpMap.wrapS = THREE.RepeatWrapping;
  bumpMap.wrapT = THREE.RepeatWrapping;
  bumpMap.repeat.set(repX, repY);
  bumpMap.anisotropy = maxAnisotropy;
  if (maxAnisotropy === 1) {
    bumpMap.generateMipmaps = false;
    bumpMap.minFilter = THREE.LinearFilter;
  }

  return {
    colorMap,
    bumpMap,
    dispose: () => {
      colorMap.dispose();
      bumpMap.dispose();
    },
  };
}

/**
 * Renders the 3D intercom's circular optical camera lens texture, including:
 * - Darkened spherical fisheye ("рыбий глаз") reflection of the user's camera feed
 * - Dynamic light-reactive specular glare ("блик") and multi-coating reflections that shift as the user rotates the 3D intercom
 */
function renderCameraOpticsCanvas(
  canvas: HTMLCanvasElement,
  localVideo?: HTMLVideoElement | null,
  camEnabled: boolean = true,
  mirrorSelf: boolean = true,
  viewOffsetX: number = 0,
  viewOffsetY: number = 0
) {
  const size = 512;
  const cx = size / 2;
  const cy = size / 2;
  const ctx = canvas.getContext('2d')!;
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.scale(canvas.width / size, canvas.height / size);

  // Clamp normalized viewing angle offsets
  const vx = Math.max(-1, Math.min(1, viewOffsetX));
  const vy = Math.max(-1, Math.min(1, viewOffsetY));

  // 1. Outer recessed anodized housing base
  const housingGrad = ctx.createLinearGradient(0, 0, size, size);
  housingGrad.addColorStop(0, '#07080b');
  housingGrad.addColorStop(0.5, '#101318');
  housingGrad.addColorStop(1, '#1c2028');
  ctx.fillStyle = housingGrad;
  ctx.fillRect(0, 0, size, size);

  // 2. Concentric machined anti-reflective baffle micro-grooves
  for (let r = 236; r >= 118; r -= 5) {
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.strokeStyle = r % 10 === 0 ? 'rgba(255,255,255,0.04)' : 'rgba(0,0,0,0.65)';
    ctx.lineWidth = 2.2;
    ctx.stroke();
  }

  // Ambient occlusion shadow from outer bezel
  const bezelShadow = ctx.createRadialGradient(
    cx - 18 + vx * 10,
    cy - 18 - vy * 10,
    110,
    cx,
    cy,
    248
  );
  bezelShadow.addColorStop(0, 'rgba(0,0,0,0)');
  bezelShadow.addColorStop(0.72, 'rgba(0,0,0,0.22)');
  bezelShadow.addColorStop(1, 'rgba(0,0,0,0.82)');
  ctx.fillStyle = bezelShadow;
  ctx.beginPath();
  ctx.arc(cx, cy, 248, 0, Math.PI * 2);
  ctx.fill();

  // Two industrial spanner wrench notches on outer retainer ring (left & right)
  ctx.fillStyle = '#050608';
  ctx.strokeStyle = 'rgba(255,255,255,0.08)';
  ctx.lineWidth = 1.5;
  [-218, 204].forEach((offsetX) => {
    ctx.fillRect(cx + offsetX, cy - 9, 14, 18);
    ctx.strokeRect(cx + offsetX, cy - 9, 14, 18);
  });

  // 3. Six recessed smoked-glass IR LED sensors around the baffle ring (r = 166)
  for (let i = 0; i < 6; i++) {
    const angle = (i / 6) * Math.PI * 2 - Math.PI / 2;
    const ix = cx + Math.cos(angle) * 166;
    const iy = cy + Math.sin(angle) * 166;

    const sockGrad = ctx.createLinearGradient(ix - 18, iy - 18, ix + 18, iy + 18);
    sockGrad.addColorStop(0, '#040507');
    sockGrad.addColorStop(1, '#262b34');
    ctx.fillStyle = sockGrad;
    ctx.beginPath();
    ctx.arc(ix, iy, 17, 0, Math.PI * 2);
    ctx.fill();

    const irGrad = ctx.createRadialGradient(ix - 4, iy - 4, 1, ix, iy, 13.5);
    irGrad.addColorStop(0, '#2d1219');
    irGrad.addColorStop(0.45, '#14070a');
    irGrad.addColorStop(1, '#050608');
    ctx.fillStyle = irGrad;
    ctx.beginPath();
    ctx.arc(ix, iy, 13.5, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = 'rgba(255, 255, 255, 0.20)';
    ctx.beginPath();
    ctx.arc(ix - 4.5 + vx * 2, iy - 4.5 - vy * 2, 2.4, 0, Math.PI * 2);
    ctx.fill();
  }

  // 4. Inner metallic lens barrel rim (r = 126)
  const barrelRimGrad = ctx.createLinearGradient(cx - 126, cy - 126, cx + 126, cy + 126);
  barrelRimGrad.addColorStop(0, '#3e4552');
  barrelRimGrad.addColorStop(0.45, '#1b1f26');
  barrelRimGrad.addColorStop(1, '#090b0f');
  ctx.fillStyle = barrelRimGrad;
  ctx.beginPath();
  ctx.arc(cx, cy, 126, 0, Math.PI * 2);
  ctx.fill();

  const stepGrad = ctx.createLinearGradient(cx - 110, cy - 110, cx + 110, cy + 110);
  stepGrad.addColorStop(0, '#090b0e');
  stepGrad.addColorStop(1, '#2c323c');
  ctx.fillStyle = stepGrad;
  ctx.beginPath();
  ctx.arc(cx, cy, 110, 0, Math.PI * 2);
  ctx.fill();

  // Micro technical specification text along inner ring
  ctx.save();
  ctx.fillStyle = 'rgba(180, 190, 205, 0.42)';
  ctx.font = '600 10.5px "JetBrains Mono", monospace';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('HD 2.8mm F2.0', cx, cy - 116);
  ctx.fillText('IR OPTICS', cx, cy + 116);
  ctx.restore();

  // 5. Deep smoked optical glass objective (r = 98) with darkened spherical fisheye reflection!
  const lensBaseGrad = ctx.createRadialGradient(cx, cy, 6, cx, cy, 98);
  lensBaseGrad.addColorStop(0, '#010205');
  lensBaseGrad.addColorStop(0.55, '#03060d');
  lensBaseGrad.addColorStop(0.85, '#070e1b');
  lensBaseGrad.addColorStop(1, '#020306');
  ctx.fillStyle = lensBaseGrad;
  ctx.beginPath();
  ctx.arc(cx, cy, 98, 0, Math.PI * 2);
  ctx.fill();

  // Subtle, darkened fisheye ("рыбий глаз") convex reflection inside the dark glass objective
  ctx.save();
  ctx.beginPath();
  ctx.arc(cx, cy, 94, 0, Math.PI * 2);
  ctx.clip();

  // Convex mirror parallax shift when tilting/rotating the intercom
  const reflShiftX = -vx * 16;
  const reflShiftY = vy * 16;

  if (camEnabled && localVideo && localVideo.readyState >= 2 && localVideo.videoWidth > 0) {
    const vw = localVideo.videoWidth;
    const vh = localVideo.videoHeight;
    const s = Math.min(vw, vh);
    const sx = (vw - s) / 2;
    const sy = (vh - s) / 2;

    // Render 9 concentric annular rings from outer rim to center with non-linear spherical barrel magnification
    // so the center bows outward and the periphery curves tightly around the convex hemisphere ("рыбий глаз")!
    const rings = 9;
    const maxR = 94;
    for (let ri = rings; ri >= 1; ri--) {
      const t = ri / rings; // 1.0 at rim -> 0.11 at center
      const ringRadius = maxR * t;
      // Fisheye barrel curve: outer rings compress wide field of view, inner rings magnify center
      const fisheyeScale = 0.72 + 0.62 * (1 - t * t);
      const drawHalf = 96 * fisheyeScale;

      ctx.save();
      ctx.beginPath();
      ctx.arc(cx + reflShiftX * (1 - t * 0.45), cy + reflShiftY * (1 - t * 0.45), ringRadius, 0, Math.PI * 2);
      ctx.clip();
      // Heavily darkened so the reflection looks like a real dark tinted pinhole lens (~22% opacity)
      ctx.globalAlpha = 0.22 * (1.05 - 0.35 * t * t);
      ctx.translate(cx + reflShiftX * 0.65, cy + reflShiftY * 0.65);
      if (mirrorSelf) {
        ctx.scale(-1, 1);
      }
      try {
        ctx.drawImage(localVideo, sx, sy, s, s, -drawHalf, -drawHalf, drawHalf * 2, drawHalf * 2);
      } catch {
        // Ignore
      }
      ctx.restore();
    }
  } else if (camEnabled) {
    // Darkened fisheye silhouette reflection in fallback / headless camera mode
    const silGrad = ctx.createRadialGradient(
      cx + reflShiftX,
      cy - 8 + reflShiftY,
      4,
      cx,
      cy,
      94
    );
    silGrad.addColorStop(0, 'rgba(38, 50, 70, 0.24)');
    silGrad.addColorStop(1, 'rgba(3, 6, 12, 0.92)');
    ctx.fillStyle = silGrad;
    ctx.fillRect(cx - 96, cy - 96, 192, 192);

    ctx.fillStyle = 'rgba(95, 115, 145, 0.16)';
    ctx.beginPath();
    ctx.ellipse(cx + reflShiftX * 0.8, cy - 12 + reflShiftY * 0.8, 26, 28, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.ellipse(cx + reflShiftX * 0.5, cy + 52 + reflShiftY * 0.5, 56, 32, 0, Math.PI, 0, false);
    ctx.fill();
  }

  // Deep smoked-glass spherical falloff & dark inner pinhole pupil (r = 24)
  const pupilGrad = ctx.createRadialGradient(cx, cy, 2, cx, cy, 32);
  pupilGrad.addColorStop(0, 'rgba(0, 1, 3, 0.72)');
  pupilGrad.addColorStop(0.55, 'rgba(1, 3, 8, 0.35)');
  pupilGrad.addColorStop(1, 'rgba(0, 0, 0, 0)');
  ctx.fillStyle = pupilGrad;
  ctx.beginPath();
  ctx.arc(cx, cy, 32, 0, Math.PI * 2);
  ctx.fill();

  const lensVignette = ctx.createRadialGradient(cx, cy, 22, cx, cy, 95);
  lensVignette.addColorStop(0, 'rgba(1, 4, 10, 0.38)');
  lensVignette.addColorStop(0.62, 'rgba(2, 6, 16, 0.68)');
  lensVignette.addColorStop(1, 'rgba(1, 2, 6, 0.96)');
  ctx.fillStyle = lensVignette;
  ctx.beginPath();
  ctx.arc(cx, cy, 95, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();

  // 6. Dynamic Light-Reactive Multi-Coating & Specular Glare ("блик", shifting with 3D camera/light angle!)
  const specX = cx - 28 + vx * 42;
  const specY = cy - 30 - vy * 42;
  const counterX = cx + 26 - vx * 34;
  const counterY = cy + 28 + vy * 34;
  const specAngle = Math.atan2(specY - cy, specX - cx) + Math.PI / 2;
  const angleBoost = Math.max(0.55, Math.min(1.35, 0.92 + (vx * 0.35 - vy * 0.35)));

  const coatGrad1 = ctx.createRadialGradient(specX, specY, 4, specX * 0.4 + cx * 0.6, specY * 0.4 + cy * 0.6, 86);
  coatGrad1.addColorStop(0, `rgba(56, 189, 248, ${(0.18 * angleBoost).toFixed(3)})`);
  coatGrad1.addColorStop(0.45, `rgba(16, 185, 129, ${(0.09 * angleBoost).toFixed(3)})`);
  coatGrad1.addColorStop(1, 'rgba(0, 0, 0, 0)');
  ctx.fillStyle = coatGrad1;
  ctx.beginPath();
  ctx.arc(cx, cy, 94, 0, Math.PI * 2);
  ctx.fill();

  const coatGrad2 = ctx.createRadialGradient(counterX, counterY, 3, counterX * 0.5 + cx * 0.5, counterY * 0.5 + cy * 0.5, 74);
  coatGrad2.addColorStop(0, `rgba(129, 140, 248, ${(0.19 * angleBoost).toFixed(3)})`);
  coatGrad2.addColorStop(0.6, 'rgba(14, 165, 233, 0.06)');
  coatGrad2.addColorStop(1, 'rgba(0, 0, 0, 0)');
  ctx.fillStyle = coatGrad2;
  ctx.beginPath();
  ctx.arc(cx, cy, 94, 0, Math.PI * 2);
  ctx.fill();

  // Subtle inner aperture ring (r = 54)
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.08)';
  ctx.lineWidth = 1.2;
  ctx.beginPath();
  ctx.arc(cx, cy, 54, 0, Math.PI * 2);
  ctx.stroke();

  // 7. Realistic curved optical glare crescent + hot specular pinpoint that glides across the convex dome
  ctx.save();
  ctx.beginPath();
  ctx.arc(cx, cy, 92, 0, Math.PI * 2);
  ctx.clip();

  const reflGrad = ctx.createRadialGradient(specX, specY, 2, specX, specY, 48);
  reflGrad.addColorStop(0, `rgba(245, 250, 255, ${(0.38 * angleBoost).toFixed(3)})`);
  reflGrad.addColorStop(0.35, `rgba(186, 230, 253, ${(0.15 * angleBoost).toFixed(3)})`);
  reflGrad.addColorStop(1, 'rgba(255, 255, 255, 0)');
  ctx.fillStyle = reflGrad;
  ctx.beginPath();
  ctx.ellipse(specX, specY, 38, 18, specAngle, 0, Math.PI * 2);
  ctx.fill();

  // Crisp primary specular highlight crescent
  ctx.save();
  ctx.translate(specX, specY);
  ctx.rotate(specAngle);
  const hotGrad = ctx.createLinearGradient(-16, 0, 16, 0);
  hotGrad.addColorStop(0, 'rgba(255, 255, 255, 0.05)');
  hotGrad.addColorStop(0.5, `rgba(255, 255, 255, ${Math.min(0.88, 0.62 * angleBoost).toFixed(3)})`);
  hotGrad.addColorStop(1, 'rgba(255, 255, 255, 0.05)');
  ctx.fillStyle = hotGrad;
  ctx.beginPath();
  ctx.ellipse(0, -3, 13, 3.6, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();

  // Secondary internal lens element ghost reflection moving in opposite direction
  const subRefl = ctx.createRadialGradient(counterX, counterY, 1, counterX, counterY, 20);
  subRefl.addColorStop(0, `rgba(147, 197, 253, ${(0.20 * angleBoost).toFixed(3)})`);
  subRefl.addColorStop(0.5, `rgba(167, 139, 250, ${(0.10 * angleBoost).toFixed(3)})`);
  subRefl.addColorStop(1, 'rgba(147, 197, 253, 0)');
  ctx.fillStyle = subRefl;
  ctx.beginPath();
  ctx.ellipse(counterX, counterY, 16, 9, specAngle, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
  ctx.restore();
}

function createCameraOpticsTexture(maxAnisotropy: number): {
  canvas: HTMLCanvasElement;
  tex: THREE.CanvasTexture;
} {
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 256;
  renderCameraOpticsCanvas(canvas, null, true, true, 0, 0);

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = maxAnisotropy;
  if (maxAnisotropy === 1) {
    tex.generateMipmaps = false;
    tex.minFilter = THREE.LinearFilter;
  }
  return { canvas, tex };
}

/**
 * Generates high-detail procedural textures for the internal speaker assembly behind the 18 cylindrical
 * faceplate bores:
 *  - Dark-gray open-cell acoustic polyurethane foam ("темно-серый акустический поролон") with realistic cellular pores
 *  - Realistic dark gunmetal over-under crimped woven wire mesh ("темная металлическая сетка") with cylindrical wire shading
 *  - Subtle underlying speaker driver diaphragm contour beneath the foam & dark metallic mesh
 */
function createSpeakerInternalMaps(maxAnisotropy: number): {
  foamCanvas: HTMLCanvasElement;
  foamColorMap: THREE.CanvasTexture;
  foamBumpMap: THREE.CanvasTexture;
  meshCanvas: HTMLCanvasElement;
  meshColorMap: THREE.CanvasTexture;
  meshBumpMap: THREE.CanvasTexture;
  dispose: () => void;
} {
  const w = 1024;
  const h = 512;

  // ============================================================================
  // LAYER 1 (BACK): Dark-Gray Open-Cell Acoustic Polyurethane Foam ("темно-серый поролон")
  // ============================================================================
  const foamCanvas = document.createElement('canvas');
  foamCanvas.width = w;
  foamCanvas.height = h;
  const fCtx = foamCanvas.getContext('2d')!;

  const foamBumpCanvas = document.createElement('canvas');
  foamBumpCanvas.width = w;
  foamBumpCanvas.height = h;
  const fbCtx = foamBumpCanvas.getContext('2d')!;

  const foamImg = fCtx.createImageData(w, h);
  const foamBumpImg = fbCtx.createImageData(w, h);

  let seed = 7319;
  const rand = () => {
    seed = (seed * 16807) % 2147483647;
    return (seed & 0xffff) / 0xffff;
  };

  // Base matte dark-gray cellular foam substrate (#23272e .. #2f343d)
  for (let py = 0; py < h; py++) {
    for (let px = 0; px < w; px++) {
      const idx = (py * w + px) * 4;
      const cellWave =
        Math.sin(px * 0.42 + py * 0.18) * Math.cos(py * 0.42 - px * 0.18) * 6 +
        (rand() - 0.5) * 10;
      const baseGray = Math.max(24, Math.min(56, Math.round(38 + cellWave)));
      foamImg.data[idx] = baseGray;
      foamImg.data[idx + 1] = baseGray + 3;
      foamImg.data[idx + 2] = baseGray + 7;
      foamImg.data[idx + 3] = 255;

      const bVal = Math.max(0, Math.min(255, Math.round(115 + cellWave * 3.0)));
      foamBumpImg.data[idx] = bVal;
      foamBumpImg.data[idx + 1] = bVal;
      foamBumpImg.data[idx + 2] = bVal;
      foamBumpImg.data[idx + 3] = 255;
    }
  }
  fCtx.putImageData(foamImg, 0, 0);
  fbCtx.putImageData(foamBumpImg, 0, 0);

  // Reticulated open-cell dark-gray sponge pores & matte foam struts
  for (let i = 0; i < 16000; i++) {
    const px = rand() * w;
    const py = rand() * h;
    const r = 0.8 + rand() * 2.4;
    const roll = rand();
    if (roll < 0.45) {
      // Deep open foam pore cavity
      fCtx.fillStyle = 'rgba(14, 16, 20, 0.82)';
      fbCtx.fillStyle = 'rgba(16, 16, 16, 0.85)';
    } else if (roll < 0.80) {
      // Matte dark-gray foam cell wall
      fCtx.fillStyle = 'rgba(44, 48, 56, 0.68)';
      fbCtx.fillStyle = 'rgba(148, 148, 148, 0.6)';
    } else {
      // Fine dark-gray foam strut edge
      fCtx.fillStyle = 'rgba(54, 59, 68, 0.55)';
      fbCtx.fillStyle = 'rgba(190, 190, 190, 0.55)';
    }
    fCtx.beginPath();
    fCtx.arc(px, py, r, 0, Math.PI * 2);
    fCtx.fill();

    fbCtx.beginPath();
    fbCtx.arc(px, py, r, 0, Math.PI * 2);
    fbCtx.fill();
  }

  // ============================================================================
  // LAYER 2 (FRONT): Continuous 3D Dark Metallic Woven Wire Mesh ("металлическая темная сетка")
  // Unbroken round gunmetal steel wires crossing at +45° and -45° with transparent diamond openings
  // ============================================================================
  const meshCanvas = document.createElement('canvas');
  meshCanvas.width = w;
  meshCanvas.height = h;
  const mCtx = meshCanvas.getContext('2d')!;
  const meshImg = mCtx.createImageData(w, h);

  const meshBumpCanvas = document.createElement('canvas');
  meshBumpCanvas.width = w;
  meshBumpCanvas.height = h;
  const mbCtx = meshBumpCanvas.getContext('2d')!;
  const meshBumpImg = mbCtx.createImageData(w, h);

  const foamData = fCtx.getImageData(0, 0, w, h);

  // On 1024x512, each circular speaker hole is ~77px in diameter.
  // P = 18.5px gives ~4.2 bold, unmistakable diamond cells across each hole!
  const P = 18.5;
  const R = 2.95; // Wire diameter = 5.9px, open diamond window = 12.6px
  const INV_SQRT2 = 0.70710678;

  for (let py = 0; py < h; py++) {
    for (let px = 0; px < w; px++) {
      const idx = (py * w + px) * 4;

      // Rotate by 45 degrees into diagonal woven wire coordinates (u, v)
      const u = (px + py) * INV_SQRT2;
      const v = (px - py) * INV_SQRT2;

      const iu = Math.round(u / P);
      const iv = Math.round(v / P);
      const du = u - iu * P;
      const dv = v - iv * P;
      const absDu = Math.abs(du);
      const absDv = Math.abs(dv);

      // Alternating over/under plain weave at each intersection (iu, iv)
      const uOverV = ((iu + iv) & 1) === 0;

      const inU = absDu < R + 0.65;
      const inV = absDv < R + 0.65;

      if (!inU && !inV) {
        // Inside the open diamond window between wires:
        // Transparent on the front metallic mesh so the back dark-gray foam shows through!
        meshImg.data[idx] = 0;
        meshImg.data[idx + 1] = 0;
        meshImg.data[idx + 2] = 0;
        meshImg.data[idx + 3] = 0;

        meshBumpImg.data[idx] = 0;
        meshBumpImg.data[idx + 1] = 0;
        meshBumpImg.data[idx + 2] = 0;
        meshBumpImg.data[idx + 3] = 255;

        // Cast shadow from the wire mesh onto the underlying dark-gray foam
        const minWireDist = Math.min(absDu, absDv) - R;
        if (minWireDist < 2.8) {
          const aoFoam = 0.58 + 0.42 * Math.max(0, minWireDist / 2.8);
          foamData.data[idx] = Math.round(foamData.data[idx] * aoFoam);
          foamData.data[idx + 1] = Math.round(foamData.data[idx + 1] * aoFoam);
          foamData.data[idx + 2] = Math.round(foamData.data[idx + 2] * aoFoam);
        }
        continue;
      }

      // Determine which continuous cylindrical wire strand is on top at this pixel
      const useU = inU && inV ? uOverV : inU;
      const dPerp = useU ? du : dv;
      const dAlong = useU ? dv : du;
      const isOver = useU ? uOverV : !uOverV;

      const absPerp = Math.abs(dPerp);
      const alphaEdge = Math.min(1, Math.max(0, (R + 0.65 - absPerp) / 0.95));

      // Continuous cylindrical cross-section profile across the round steel wire (-1 .. +1)
      const tPerp = Math.max(-0.98, Math.min(0.98, dPerp / R));
      const zCyl = Math.sqrt(1 - tPerp * tPerp);

      // Continuous cylindrical lighting along the entire length of the wire (NO point dots!)
      // Top-left directional light across the round wire cylinder:
      const lightCross = Math.max(0, -tPerp * 0.55 + zCyl * 0.83);
      // Continuous metallic ridge highlight along the wire spine:
      const ridgeSpec = Math.pow(Math.max(0, zCyl - Math.abs(tPerp + 0.18) * 0.35), 5);

      // Subtle overlap shadow ONLY right where the under-wire ducks beneath the crossing over-wire
      const distFromCrossingEdge = Math.max(0, Math.abs(dAlong) - R);
      const underShadow = isOver
        ? 1.04
        : 0.58 + 0.42 * Math.min(1, distFromCrossingEdge / 3.2);

      const cylEdgeShade = 0.38 + 0.62 * zCyl;
      const shade = cylEdgeShade * underShadow;

      // Authentic Dark Gunmetal / Blackened Steel palette (#14171c edge -> #343b46 body -> #5e6878 metallic ridge)
      const rWire = Math.min(108, Math.max(12, Math.round((20 + 28 * lightCross + 48 * ridgeSpec) * shade)));
      const gWire = Math.min(118, Math.max(14, Math.round((23 + 32 * lightCross + 54 * ridgeSpec) * shade)));
      const bWire = Math.min(132, Math.max(17, Math.round((27 + 38 * lightCross + 62 * ridgeSpec) * shade)));

      meshImg.data[idx] = rWire;
      meshImg.data[idx + 1] = gWire;
      meshImg.data[idx + 2] = bWire;
      meshImg.data[idx + 3] = Math.round(alphaEdge * 255);

      const bumpH = Math.min(
        255,
        Math.max(20, Math.round(115 + zCyl * 105 + (isOver ? 20 : -15)))
      );
      meshBumpImg.data[idx] = bumpH;
      meshBumpImg.data[idx + 1] = bumpH;
      meshBumpImg.data[idx + 2] = bumpH;
      meshBumpImg.data[idx + 3] = 255;
    }
  }

  fCtx.putImageData(foamData, 0, 0);
  mCtx.putImageData(meshImg, 0, 0);
  mbCtx.putImageData(meshBumpImg, 0, 0);

  const foamColorMap = new THREE.CanvasTexture(foamCanvas);
  foamColorMap.colorSpace = THREE.SRGBColorSpace;
  foamColorMap.anisotropy = maxAnisotropy;

  const foamBumpMap = new THREE.CanvasTexture(foamBumpCanvas);
  foamBumpMap.anisotropy = maxAnisotropy;

  const meshColorMap = new THREE.CanvasTexture(meshCanvas);
  meshColorMap.colorSpace = THREE.SRGBColorSpace;
  meshColorMap.anisotropy = maxAnisotropy;

  const meshBumpMap = new THREE.CanvasTexture(meshBumpCanvas);
  meshBumpMap.anisotropy = maxAnisotropy;

  if (maxAnisotropy === 1) {
    foamColorMap.generateMipmaps = false;
    foamColorMap.minFilter = THREE.LinearFilter;
    foamBumpMap.generateMipmaps = false;
    foamBumpMap.minFilter = THREE.LinearFilter;
    meshColorMap.generateMipmaps = false;
    meshColorMap.minFilter = THREE.LinearFilter;
    meshBumpMap.generateMipmaps = false;
    meshBumpMap.minFilter = THREE.LinearFilter;
  }

  return {
    foamCanvas,
    foamColorMap,
    foamBumpMap,
    meshCanvas,
    meshColorMap,
    meshBumpMap,
    dispose: () => {
      foamColorMap.dispose();
      foamBumpMap.dispose();
      meshColorMap.dispose();
      meshBumpMap.dispose();
    },
  };
}


/**
 * Renders distinct, authentic brand typography for ELTIS, VIZIT, and CYFRAL (without icons/emblems).
 */
function drawBrandNameplate(
  ctx: CanvasRenderingContext2D,
  targetBrand: IntercomBrand,
  modelSubText: string
) {
  ctx.clearRect(0, 0, 512, 72);

  if (targetBrand === 'eltis') {
    ctx.fillStyle = '#eceef2';
    ctx.font = 'italic 700 44px Georgia, "Times New Roman", serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText('ELTIS', 14, 36);

    ctx.fillStyle = '#8b93a4';
    ctx.fillRect(14, 56, 132, 2.5);

    ctx.fillStyle = '#c4c9d4';
    ctx.font = '700 21px "JetBrains Mono", monospace';
    ctx.textAlign = 'right';
    ctx.fillText(modelSubText, 496, 38);
  } else if (targetBrand === 'vizit') {
    ctx.font = '900 42px "Arial Black", "Impact", sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';

    const letters = ['V', 'I', 'Z', 'I', 'T'];
    let xCursor = 14;
    letters.forEach((ch) => {
      ctx.fillStyle = 'rgba(255, 230, 200, 0.35)';
      ctx.fillText(ch, xCursor + 1.5, 37.5);
      ctx.fillStyle = '#190f07';
      ctx.fillText(ch, xCursor, 36);
      xCursor += ch === 'I' ? 23 : 36;
    });

    ctx.fillStyle = 'rgba(25, 15, 7, 0.55)';
    ctx.fillRect(14, 55, 148, 2.5);

    ctx.strokeStyle = 'rgba(25, 15, 7, 0.65)';
    ctx.lineWidth = 2;
    ctx.strokeRect(366, 19, 130, 34);
    ctx.fillStyle = '#1f1309';
    ctx.font = '700 20px "JetBrains Mono", monospace';
    ctx.textAlign = 'center';
    ctx.fillText(modelSubText, 431, 37);
  } else {
    ctx.font = '700 38px "Trebuchet MS", "Copperplate", Georgia, serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    const cyfLetters = ['C', 'Y', 'F', 'R', 'A', 'L'];
    let cx = 14;
    cyfLetters.forEach((ch) => {
      ctx.fillStyle = '#f3eae2';
      ctx.fillText(ch, cx, 36);
      cx += 30;
    });

    ctx.fillStyle = 'rgba(243, 234, 226, 0.38)';
    ctx.fillRect(14, 55, 174, 2);

    ctx.fillStyle = '#d8c7b8';
    ctx.font = '700 20px "JetBrains Mono", monospace';
    ctx.textAlign = 'right';
    ctx.fillText(modelSubText, 496, 38);
  }
}

function createRoundedRectShape(width: number, height: number, radius: number): THREE.Shape {
  const shape = new THREE.Shape();
  const x = -width / 2;
  const y = -height / 2;
  shape.moveTo(x + radius, y);
  shape.lineTo(x + width - radius, y);
  shape.quadraticCurveTo(x + width, y, x + width, y + radius);
  shape.lineTo(x + width, y + height - radius);
  shape.quadraticCurveTo(x + width, y + height, x + width - radius, y + height);
  shape.lineTo(x + radius, y + height);
  shape.quadraticCurveTo(x, y + height, x, y + height - radius);
  shape.lineTo(x, y + radius);
  shape.quadraticCurveTo(x, y, x + radius, y);
  return shape;
}

export const IntercomScene3D: React.FC<IntercomScene3DProps> = ({
  brand,
  displayText,
  pressedKeyTrigger,
  onKeyPress,
  remoteVideoCanvasRef,
  localVideoElementRef,
  remoteVideoElementRef,
  remoteFrameSeq,
  isCallConnected,
  peerPin,
  myPin,
  camEnabled,
  micEnabled = true,
  peerMicEnabled = true,
  peerCamEnabled = true,
  mirrorLocalVideo,
  showSelfPreview = true,
  onToggleSelfPreview,
  remoteRotation = 'auto',
  baselinePeerIsPortrait = null,
  onRotateRemoteVideo,
  isNightMode = false,
}) => {
  const mountRef = useRef<HTMLDivElement | null>(null);
  const onKeyPressRef = useRef(onKeyPress);
  onKeyPressRef.current = onKeyPress;
  const onToggleSelfPreviewRef = useRef(onToggleSelfPreview);
  onToggleSelfPreviewRef.current = onToggleSelfPreview;
  const onRotateRemoteVideoRef = useRef(onRotateRemoteVideo);
  onRotateRemoteVideoRef.current = onRotateRemoteVideo;

  // Draggable PiP coordinates inside the 512x320 embedded intercom screen
  const pipStateRef = useRef({
    x: 318,
    y: 168,
    w: 180,
    h: 132,
    dragging: false,
    dragOffsetX: 0,
    dragOffsetY: 0,
  });

  const livePropsRef = useRef({
    brand,
    displayText,
    isCallConnected: Boolean(isCallConnected),
    peerPin,
    myPin,
    camEnabled: Boolean(camEnabled),
    micEnabled: Boolean(micEnabled),
    peerMicEnabled: Boolean(peerMicEnabled),
    peerCamEnabled: Boolean(peerCamEnabled),
    mirrorLocalVideo: Boolean(mirrorLocalVideo),
    showSelfPreview: Boolean(showSelfPreview),
    remoteRotation: (remoteRotation ?? 'auto') as RemoteRotationMode,
    baselinePeerIsPortrait: baselinePeerIsPortrait ?? null,
    isNightMode: Boolean(isNightMode),
  });
  livePropsRef.current = {
    brand,
    displayText,
    isCallConnected: Boolean(isCallConnected),
    peerPin,
    myPin,
    camEnabled: Boolean(camEnabled),
    micEnabled: Boolean(micEnabled),
    peerMicEnabled: Boolean(peerMicEnabled),
    peerCamEnabled: Boolean(peerCamEnabled),
    mirrorLocalVideo: Boolean(mirrorLocalVideo),
    showSelfPreview: Boolean(showSelfPreview),
    remoteRotation: (remoteRotation ?? 'auto') as RemoteRotationMode,
    baselinePeerIsPortrait: baselinePeerIsPortrait ?? null,
    isNightMode: Boolean(isNightMode),
  };

  const sceneApiRef = useRef<{
    switchBrand: (b: IntercomBrand) => void;
    updateDisplay: (text: string, b: IntercomBrand) => void;
    triggerButtonPress: (label: string) => void;
    refreshVideoScreen: () => void;
    setNightMode: (night: boolean) => void;
  } | null>(null);

  useEffect(() => {
    const container = mountRef.current;
    if (!container) return;

    const isSoftwareGl = (() => {
      try {
        if (typeof navigator !== 'undefined' && navigator.webdriver) return true;
        const probeCanvas = document.createElement('canvas');
        const gl = probeCanvas.getContext('webgl2') || probeCanvas.getContext('webgl');
        if (!gl) return true;
        const ext = gl.getExtension('WEBGL_debug_renderer_info');
        const param = ext ? ext.UNMASKED_RENDERER_WEBGL : gl.RENDERER;
        const gpu = String(gl.getParameter(param));
        gl.getExtension('WEBGL_lose_context')?.loseContext();
        return /SwiftShader|llvmpipe|softpipe|Software|Basic Render|Subzero/i.test(gpu);
      } catch {
        return true;
      }
    })();

    const capMetal = (m: number) => (isSoftwareGl ? Math.min(m, 0.25) : m);
    const optBump = (tex: THREE.Texture) => (isSoftwareGl ? null : tex);
    const createMat = (params: THREE.MeshStandardMaterialParameters): THREE.Material => {
      if (isSoftwareGl) {
        const basicParams: THREE.MeshBasicMaterialParameters = {
          color: params.color,
        };
        if (params.map) basicParams.map = params.map;
        if (params.transparent !== undefined) basicParams.transparent = params.transparent;
        if (params.opacity !== undefined) basicParams.opacity = params.opacity;
        return new THREE.MeshBasicMaterial(basicParams);
      }
      return new THREE.MeshStandardMaterial(params);
    };

    const width = container.clientWidth || window.innerWidth;
    const height = container.clientHeight || window.innerHeight;

    const scene = new THREE.Scene();
    const bgHex = 0x0b0c0e;
    scene.background = new THREE.Color(bgHex);
    if (!isSoftwareGl) {
      scene.fog = new THREE.FogExp2(bgHex, 0.055);
    }

    // Optimized near/far plane ratio (0.25 .. 25) to maximize mobile depth-buffer precision and prevent Z-fighting when zoomed out
    const camera = new THREE.PerspectiveCamera(40, width / height, 0.25, 25);

    let renderer: THREE.WebGLRenderer | null = null;
    let softCanvas: HTMLCanvasElement | null = null;
    let domElem: HTMLCanvasElement;

    if (!isSoftwareGl) {
      renderer = new THREE.WebGLRenderer({
        antialias: true,
        powerPreference: 'high-performance',
      });
      renderer.outputColorSpace = THREE.SRGBColorSpace;
      renderer.toneMapping = THREE.ACESFilmicToneMapping;
      renderer.toneMappingExposure = 1.12;
      renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
      renderer.setSize(width, height);
      renderer.shadowMap.enabled = true;
      renderer.shadowMap.type = THREE.PCFShadowMap;

      const pmremGenerator = new THREE.PMREMGenerator(renderer);
      scene.environment = pmremGenerator.fromScene(new RoomEnvironment(), 0.04).texture;
      pmremGenerator.dispose();
      domElem = renderer.domElement;
    } else {
      softCanvas = document.createElement('canvas');
      softCanvas.width = width;
      softCanvas.height = height;
      softCanvas.style.width = '100%';
      softCanvas.style.height = '100%';
      softCanvas.style.display = 'block';
      domElem = softCanvas;
    }

    container.innerHTML = '';
    container.appendChild(domElem);

    const controls = new OrbitControls(camera, domElem);
    // Allow smooth inertial rotation & zooming while preventing clipping or jumping at far distance
    controls.zoomToCursor = true;
    controls.enablePan = true;
    controls.screenSpacePanning = true;
    controls.enableDamping = true;
    controls.dampingFactor = isSoftwareGl ? 0.22 : 0.085;
    controls.rotateSpeed = 0.72;
    controls.zoomSpeed = 0.9;
    controls.panSpeed = 0.75;
    controls.minDistance = 0.65;
    controls.maxDistance = 7.8;
    controls.minPolarAngle = Math.PI / 2.8;
    controls.maxPolarAngle = Math.PI / 1.58;
    controls.minAzimuthAngle = -Math.PI / 3.2;
    controls.maxAzimuthAngle = Math.PI / 3.2;

    // Prevent the orbit target from drifting away from the intercom while preserving the camera-to-target
    // offset vector so rotating quickly from afar never snaps or jumps the spherical orbit!
    let isClampingCamera = false;
    function enforceCameraOutsideIntercom() {
      if (isClampingCamera) return;
      isClampingCamera = true;

      const clampedTargetX = Math.max(-0.82, Math.min(0.82, controls.target.x));
      const clampedTargetY = Math.max(-1.42, Math.min(1.52, controls.target.y));
      const clampedTargetZ = Math.max(0.06, Math.min(0.28, controls.target.z));

      const dx = clampedTargetX - controls.target.x;
      const dy = clampedTargetY - controls.target.y;
      const dz = clampedTargetZ - controls.target.z;

      if (dx !== 0 || dy !== 0 || dz !== 0) {
        controls.target.set(clampedTargetX, clampedTargetY, clampedTargetZ);
        camera.position.x += dx;
        camera.position.y += dy;
        camera.position.z += dz;
      }

      // Frontmost intercom visor & buttons sit around z = 0.14..0.16; keep camera strictly in front (z >= 0.48)
      if (camera.position.z < 0.48) {
        camera.position.z = 0.48;
      }

      isClampingCamera = false;
    }

    function fitCameraToViewport(w: number, h: number) {
      const aspect = w / Math.max(h, 1);
      camera.aspect = aspect;
      camera.updateProjectionMatrix();

      let dist = 5.55;
      let targetY = -0.15;

      if (aspect < 0.65) {
        dist = 6.05;
        targetY = -0.2;
      } else if (aspect < 1.0) {
        dist = 5.75;
        targetY = -0.18;
      } else if (h < 700) {
        dist = 5.85;
        targetY = -0.16;
      }

      camera.position.set(0, targetY + 0.04, dist);
      controls.target.set(0, targetY, 0.08);
      controls.update();
      enforceCameraOutsideIntercom();
    }

    fitCameraToViewport(width, height);

    const hemiLight = new THREE.HemisphereLight(0xdce6f5, 0x181a1f, 0.68);
    hemiLight.position.set(0, 8, 0);
    scene.add(hemiLight);

    const keyLight = new THREE.DirectionalLight(0xfff5e8, 1.55);
    keyLight.position.set(3.2, 4.6, 4.2);
    if (!isSoftwareGl) {
      keyLight.castShadow = true;
      keyLight.shadow.mapSize.width = 1024;
      keyLight.shadow.mapSize.height = 1024;
      const d = 2.6;
      keyLight.shadow.camera.left = -d;
      keyLight.shadow.camera.right = d;
      keyLight.shadow.camera.top = d;
      keyLight.shadow.camera.bottom = -d;
      keyLight.shadow.camera.near = 0.5;
      keyLight.shadow.camera.far = 12;
      keyLight.shadow.bias = -0.0005;
      keyLight.shadow.normalBias = 0.02;
    }
    scene.add(keyLight);

    const rimLight = new THREE.DirectionalLight(0x9ab0c9, 0.58);
    rimLight.position.set(-3.4, 2.2, -2.0);
    scene.add(rimLight);

    const maxAnisotropy = isSoftwareGl || !renderer ? 1 : renderer.capabilities.getMaxAnisotropy();

    // Distinct tactile surface texture maps for each finish:
    // 1) ELTIS = fine powder-coat stipple ('powder')
    // 2) VIZIT = directional satin metallic ('satin-metallic')
    // 3) CYFRAL = coarse hammered cellular relief ('hammered')
    const armorSurface = createTactileSurfaceMaps('cast', 0x262930, maxAnisotropy);
    const eltisSurface = createTactileSurfaceMaps('powder', 0x262a31, maxAnisotropy);
    const vizitSurface = createTactileSurfaceMaps('satin-metallic', 0xa66e38, maxAnisotropy);
    const cyfralSurface = createTactileSurfaceMaps('hammered', 0x563624, maxAnisotropy);
    const darkInsertSurface = createTactileSurfaceMaps('cast', 0x1a1c21, maxAnisotropy);
    const keycapSurface = createTactileSurfaceMaps('cast', 0x2b2e36, maxAnisotropy);
    const speakerInternalSurface = createSpeakerInternalMaps(maxAnisotropy);
    const { canvas: cameraOpticsCanvas, tex: cameraOpticsTex } =
      createCameraOpticsTexture(maxAnisotropy);

    const mountAssembly = new THREE.Group();

    // High polygon counts for ultra-smooth rounded corners, bevels, and cylindrical contours
    const curveSegs = isSoftwareGl ? 8 : 36;
    const bevelSegs = isSoftwareGl ? 3 : 12;

    // 1. Dark architectural steel door surface backdrop
    const doorBackdropGeo = new THREE.ExtrudeGeometry(createRoundedRectShape(2.1, 3.34, 0.14), {
      depth: 0.04,
      curveSegments: curveSegs,
      bevelEnabled: true,
      bevelThickness: 0.018,
      bevelSize: 0.018,
      bevelSegments: bevelSegs,
    });
    doorBackdropGeo.center();
    const doorBackdropMat = createMat({
      color: 0x131518,
      roughness: 0.85,
      metalness: capMetal(0.25),
      bumpMap: optBump(armorSurface.bumpMap),
      bumpScale: 0.008,
    });
    const doorBackdrop = new THREE.Mesh(doorBackdropGeo, doorBackdropMat);
    doorBackdrop.position.set(0, 0.06, -0.12);
    doorBackdrop.receiveShadow = true;
    mountAssembly.add(doorBackdrop);

    // 2. Rubber weatherproof sealing gasket around intercom perimeter
    const gasketGeo = new THREE.ExtrudeGeometry(createRoundedRectShape(1.9, 3.16, 0.11), {
      depth: 0.035,
      curveSegments: curveSegs,
      bevelEnabled: true,
      bevelThickness: 0.014,
      bevelSize: 0.014,
      bevelSegments: bevelSegs,
    });
    gasketGeo.center();
    const gasketMat = createMat({
      color: 0x090a0b,
      roughness: 0.92,
      metalness: 0.05,
    });
    const gasket = new THREE.Mesh(gasketGeo, gasketMat);
    gasket.position.set(0, 0.06, -0.075);
    mountAssembly.add(gasket);

    // 3. Smoothly contoured high-poly die-cast aluminum outer armor surround frame ("обводка домофона")
    const outerFrameShape = createRoundedRectShape(1.82, 3.08, 0.095);
    const innerHolePath = createRoundedRectShape(1.62, 2.9, 0.045);
    outerFrameShape.holes.push(innerHolePath);
    const armorFrameGeo = new THREE.ExtrudeGeometry(outerFrameShape, {
      depth: 0.19,
      curveSegments: curveSegs,
      bevelEnabled: true,
      bevelThickness: 0.036,
      bevelSize: 0.026,
      bevelSegments: bevelSegs,
    });
    armorFrameGeo.center();
    const armorFrameMat = createMat({
      color: 0xffffff,
      map: armorSurface.colorMap,
      metalness: capMetal(0.68),
      roughness: 0.46,
      bumpMap: optBump(armorSurface.bumpMap),
      bumpScale: 0.014,
    });
    const armorFrame = new THREE.Mesh(armorFrameGeo, armorFrameMat);
    armorFrame.position.set(0, 0.06, 0.025);
    armorFrame.castShadow = true;
    armorFrame.receiveShadow = true;
    mountAssembly.add(armorFrame);

    // 4. Smoothly rounded upper visor lip integrated into the top arch of the armor frame
    const topVisorShape = createRoundedRectShape(1.74, 0.055, 0.027);
    const topVisorGeo = new THREE.ExtrudeGeometry(topVisorShape, {
      depth: 0.19,
      curveSegments: curveSegs,
      bevelEnabled: true,
      bevelThickness: 0.028,
      bevelSize: 0.024,
      bevelSegments: bevelSegs,
    });
    topVisorGeo.center();
    const smoothVisor = new THREE.Mesh(topVisorGeo, armorFrameMat);
    smoothVisor.position.set(0, 1.565, 0.045);
    smoothVisor.rotation.x = 0.05;
    mountAssembly.add(smoothVisor);

    scene.add(mountAssembly);

    // Shared 7-segment LED Display CanvasTexture
    const displayCanvas = document.createElement('canvas');
    displayCanvas.width = 256;
    displayCanvas.height = 96;
    const displayTex = new THREE.CanvasTexture(displayCanvas);
    displayTex.colorSpace = THREE.SRGBColorSpace;
    displayTex.anisotropy = maxAnisotropy;
    if (isSoftwareGl) {
      displayTex.generateMipmaps = false;
      displayTex.minFilter = THREE.LinearFilter;
    }

    // High-resolution Optical Video Monitor CanvasTexture (512x320)
    const videoScreenCanvas = document.createElement('canvas');
    videoScreenCanvas.width = 512;
    videoScreenCanvas.height = 320;
    const videoScreenTex = new THREE.CanvasTexture(videoScreenCanvas);
    videoScreenTex.colorSpace = THREE.SRGBColorSpace;
    videoScreenTex.anisotropy = maxAnisotropy;
    if (isSoftwareGl) {
      videoScreenTex.generateMipmaps = false;
      videoScreenTex.minFilter = THREE.LinearFilter;
    }

    const brandGroups: Record<IntercomBrand, THREE.Group> = {
      eltis: new THREE.Group(),
      vizit: new THREE.Group(),
      cyfral: new THREE.Group(),
    };

    const buttonsByBrand: Record<IntercomBrand, THREE.Object3D[]> = {
      eltis: [],
      vizit: [],
      cyfral: [],
    };

    const monitorScreensByBrand: Record<IntercomBrand, THREE.Mesh | null> = {
      eltis: null,
      vizit: null,
      cyfral: null,
    };

    const buttonWrapMap: Record<IntercomBrand, Map<string, THREE.Group>> = {
      eltis: new Map(),
      vizit: new Map(),
      cyfral: new Map(),
    };

    // Pre-build shared high-poly 3D concave ("немного вдавленная") machined metal keycap geometry
    // with arc-length UV parameterization along the bevel & cylindrical side skirt so the tactile
    // sandblasted texture wraps around the sides at 1:1 texel density without stretching!
    const BTN_REST_Z = 0.112;
    const BTN_PRESSED_Z = 0.098;
    const radialSegs = isSoftwareGl ? 24 : 64;

    const rimGeo = new THREE.TorusGeometry(
      0.118,
      0.013,
      isSoftwareGl ? 10 : 24,
      radialSegs
    );
    const rimMat = createMat({
      color: 0x4f5560,
      metalness: capMetal(0.42),
      roughness: 0.72,
      bumpMap: optBump(armorSurface.bumpMap),
      bumpScale: 0.016,
    });
    const socketHoleGeo = new THREE.CircleGeometry(0.114, radialSegs);
    const socketHoleMat = new THREE.MeshBasicMaterial({
      color: 0x050608,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
    });

    // High-poly unified lathe profile: cylindrical side skirt + multi-step rounded bevel + concave top dish
    const capPoints: THREE.Vector2[] = [
      new THREE.Vector2(0.106, -0.024),
      new THREE.Vector2(0.1058, -0.012),
      new THREE.Vector2(0.1055, 0.000),
      new THREE.Vector2(0.1050, 0.0075),
      new THREE.Vector2(0.1040, 0.0120),
      new THREE.Vector2(0.1020, 0.0155),
      new THREE.Vector2(0.0990, 0.0182),
      new THREE.Vector2(0.0952, 0.0202),
      new THREE.Vector2(0.0910, 0.0213),
      new THREE.Vector2(0.0870, 0.0216),
      new THREE.Vector2(0.0830, 0.0215),
    ];
    const dishRadius = 0.080;
    const dishSteps = isSoftwareGl ? 8 : 22;
    for (let s = dishSteps; s >= 0; s--) {
      const t = s / dishSteps;
      const r = dishRadius * t;
      // Smooth parabolic concave finger depression dipping to z = 0.0082 at center
      const z = 0.0082 + 0.013 * (t * t);
      capPoints.push(new THREE.Vector2(r, z));
    }

    const concaveBtnGeo = new THREE.LatheGeometry(capPoints, radialSegs);
    concaveBtnGeo.rotateX(Math.PI / 2);
    concaveBtnGeo.computeVertexNormals();

    // Arc-length UV mapping:
    // - Inside the concave dish (r <= 0.087), uvR scales linearly with r from 0 to 0.38 (rNorm = 0..0.76)
    // - Along the rounded bevel and cylindrical side wall (z < 0.0213), uvR advances by true 3D arc length
    //   from 0.38 out to 0.495 (rNorm = 0.76..0.99), eliminating vertical UV stretching on the button sides!
    const posAttr = concaveBtnGeo.attributes.position;
    const uvAttr = concaveBtnGeo.attributes.uv;
    const dishLipR = 0.087;
    const dishUvMax = 0.38;
    const sideHeightSpan = 0.0216 - -0.024; // 0.0456m
    for (let vi = 0; vi < posAttr.count; vi++) {
      const vx = posAttr.getX(vi);
      const vy = posAttr.getY(vi);
      const vz = posAttr.getZ(vi);
      const rXY = Math.sqrt(vx * vx + vy * vy);
      let uvR = 0;
      if (rXY <= dishLipR && vz >= 0.008) {
        uvR = (rXY / dishLipR) * dishUvMax;
      } else {
        const radialOut = Math.max(0, rXY - dishLipR);
        const verticalDrop = Math.max(0, 0.0216 - vz);
        const sideProgress = Math.min(1, (radialOut * 0.9 + verticalDrop) / (0.019 + sideHeightSpan));
        uvR = dishUvMax + sideProgress * (0.495 - dishUvMax);
      }
      const nx = rXY > 1e-5 ? vx / rXY : 0;
      const ny = rXY > 1e-5 ? vy / rXY : 0;
      uvAttr.setXY(vi, 0.5 + nx * uvR, 0.5 + ny * uvR);
    }
    uvAttr.needsUpdate = true;

    // Helper to punch the 18 straight cylindrical speaker holes into the upper insert at offset (centerX, centerY)
    function addSpeakerHolesToShape(
      shape: THREE.Shape,
      centerX: number,
      centerY: number,
      holeRadius = 0.0126
    ) {
      for (let r = 0; r < 3; r++) {
        for (let c = 0; c < 6; c++) {
          const hx = centerX - 0.125 + c * 0.05;
          const hy = centerY - 0.042 + r * 0.042;
          const holePath = new THREE.Path();
          holePath.absarc(hx, hy, holeRadius, 0, Math.PI * 2, true);
          shape.holes.push(holePath);
        }
      }
    }

    // Helper to cut a rectangular acoustic bay window in the main body behind upperInsert so body bevels
    // never pinch or obstruct the 18 straight cylindrical speaker tunnels!
    function addSpeakerAcousticBayToBodyShape(
      shape: THREE.Shape,
      centerX: number,
      centerY: number
    ) {
      const hw = 0.165;
      const hh = 0.072;
      const bayPath = new THREE.Path();
      bayPath.moveTo(centerX - hw, centerY - hh);
      bayPath.lineTo(centerX - hw, centerY + hh);
      bayPath.lineTo(centerX + hw, centerY + hh);
      bayPath.lineTo(centerX + hw, centerY - hh);
      bayPath.closePath();
      shape.holes.push(bayPath);
    }

    // Two-layer internal 3D speaker assembly behind the 18 cylindrical faceplate holes (depth = 0.015, z = 0.097 -> 0.082):
    // 1) Front layer at z = 0.0815: 3D Dark Metallic Woven Wire Mesh with transparent diamond openings
    // 2) Back layer at z = 0.0740: Matte Dark-Gray Porous Acoustic Polyurethane Foam behind the wire mesh
    const speakerPlateW = 0.34;
    const speakerPlateH = 0.15;
    const speakerBoreDepth = 0.015;
    const speakerPlateShape = createRoundedRectShape(speakerPlateW, speakerPlateH, 0.018);
    addSpeakerHolesToShape(speakerPlateShape, 0, 0, 0.0126);
    const speakerGrilleGeo = new THREE.ExtrudeGeometry(speakerPlateShape, {
      depth: speakerBoreDepth,
      curveSegments: isSoftwareGl ? 10 : 28,
      bevelEnabled: false,
    });
    speakerGrilleGeo.center();

    const speakerGrilleMat = createMat({
      color: 0x181c24,
      metalness: capMetal(0.55),
      roughness: 0.64,
      bumpMap: optBump(darkInsertSurface.bumpMap),
      bumpScale: 0.008,
    });
    const speakerBoreSleeveGeo = new THREE.CylinderGeometry(
      0.0125,
      0.0125,
      speakerBoreDepth,
      isSoftwareGl ? 12 : 28,
      1,
      true
    );
    speakerBoreSleeveGeo.rotateX(Math.PI / 2);
    const speakerBoreSleeveMat = createMat({
      color: 0x202631,
      metalness: capMetal(0.62),
      roughness: 0.52,
      side: THREE.BackSide,
    });

    const speakerChamberGeo = new THREE.PlaneGeometry(speakerPlateW - 0.006, speakerPlateH - 0.006);

    // Back layer (z = 0.074): Matte non-metallic dark-gray open-cell acoustic foam behind the wire mesh
    const speakerFoamMat = createMat({
      color: 0xffffff,
      map: speakerInternalSurface.foamColorMap,
      bumpMap: optBump(speakerInternalSurface.foamBumpMap),
      bumpScale: 0.018,
      metalness: 0.0,
      roughness: 0.95,
      emissive: new THREE.Color(0xffffff),
      emissiveMap: isSoftwareGl ? undefined : speakerInternalSurface.foamColorMap,
      emissiveIntensity: 0.38,
    });

    // Front layer (z = 0.0815): 3D Dark Metallic Woven Wire Mesh with transparent diamond cutouts
    const speakerMeshMat = createMat({
      color: 0xffffff,
      map: speakerInternalSurface.meshColorMap,
      bumpMap: optBump(speakerInternalSurface.meshBumpMap),
      bumpScale: 0.026,
      transparent: true,
      alphaTest: 0.12,
      metalness: capMetal(0.32),
      roughness: 0.34,
      emissive: new THREE.Color(0xffffff),
      emissiveMap: isSoftwareGl ? undefined : speakerInternalSurface.meshColorMap,
      emissiveIntensity: 0.42,
    });

    // Pre-calculate the base 256x256 matte concave shading & tactile sandblasted stipple ("шероховатость")
    // covering both the concave dish (rNorm <= 0.76) and the arc-length-mapped side walls (rNorm > 0.76)
    const btnTexSize = 256;
    const btnCx = btnTexSize / 2;
    const btnCy = btnTexSize / 2;
    const baseDishDelta = new Int16Array(btnTexSize * btnTexSize);
    const sharedBumpCanvas = document.createElement('canvas');
    sharedBumpCanvas.width = btnTexSize;
    sharedBumpCanvas.height = btnTexSize;
    const sharedBumpCtx = sharedBumpCanvas.getContext('2d')!;
    const sharedBumpImg = sharedBumpCtx.createImageData(btnTexSize, btnTexSize);
    {
      let seed = 4099;
      const rand = () => {
        seed = (seed * 16807) % 2147483647;
        return (seed & 0xffff) / 0xffff;
      };
      for (let py = 0; py < btnTexSize; py++) {
        for (let px = 0; px < btnTexSize; px++) {
          const pIdx = py * btnTexSize + px;
          const dx = (px - btnCx) / btnCx;
          const dy = (py - btnCy) / btnCy;
          const rNorm = Math.sqrt(dx * dx + dy * dy);

          let dishLight = 0;
          let bumpHeight = 128;
          if (rNorm < 0.76) {
            const tDish = rNorm / 0.76;
            const slopeDot = (dx * 0.65 - dy * 0.65) * tDish;
            dishLight = -13 * (1 - tDish * tDish) + slopeDot * 15;
            bumpHeight = 84 + Math.round(tDish * tDish * 66);
          } else {
            // Bevel shoulder & cylindrical side wall zone (rNorm = 0.76..0.99)
            const tSide = Math.min(1, (rNorm - 0.76) / 0.23);
            const rimTone = (-dx * 0.45 + dy * 0.45) * 6 * (1 - tSide * 0.5) - tSide * 8;
            dishLight = rimTone;
            bumpHeight = Math.round(156 - tSide * 28);
          }

          // Fine isotropic sandblasted grit across both top dish and side walls
          const grit = (rand() + rand() - 1.0) * 26;
          baseDishDelta[pIdx] = Math.round(dishLight + grit);
          const bVal = Math.min(255, Math.max(0, Math.round(bumpHeight + grit * 3.0)));
          const idx = pIdx * 4;
          sharedBumpImg.data[idx] = bVal;
          sharedBumpImg.data[idx + 1] = bVal;
          sharedBumpImg.data[idx + 2] = bVal;
          sharedBumpImg.data[idx + 3] = 255;
        }
      }
      sharedBumpCtx.putImageData(sharedBumpImg, 0, 0);

      for (let i = 0; i < 1800; i++) {
        const nx = rand() * btnTexSize;
        const ny = rand() * btnTexSize;
        const nRad = 0.7 + rand() * 1.5;
        const isPeak = rand() > 0.48;
        sharedBumpCtx.fillStyle = isPeak ? 'rgba(235,235,235,0.62)' : 'rgba(20,20,20,0.62)';
        sharedBumpCtx.beginPath();
        sharedBumpCtx.arc(nx, ny, nRad, 0, Math.PI * 2);
        sharedBumpCtx.fill();
      }
    }

    const sharedButtonBumpTex = new THREE.CanvasTexture(sharedBumpCanvas);
    sharedButtonBumpTex.anisotropy = maxAnisotropy;

    const sharedButtonMaterials = new Map<string, THREE.Material>();
    const buttonCapCanvases = new Map<string, HTMLCanvasElement>();
    const brandLogoCanvases: Record<IntercomBrand, HTMLCanvasElement | null> = {
      eltis: null,
      vizit: null,
      cyfral: null,
    };
    const disposableButtonTextures: THREE.Texture[] = [sharedButtonBumpTex];

    KEY_LABELS.forEach((label, labelIdx) => {
      const capCanvas = document.createElement('canvas');
      capCanvas.width = btnTexSize;
      capCanvas.height = btnTexSize;
      const cCtx = capCanvas.getContext('2d')!;
      const cImg = cCtx.createImageData(btnTexSize, btnTexSize);

      // Subdued matte sandblasted gunmetal steel for 0-9, matte dark emerald for B, matte dark crimson for C
      const baseRGB =
        label === 'B'
          ? [32, 92, 54]
          : label === 'C'
            ? [110, 38, 38]
            : [84, 90, 100];

      for (let pIdx = 0; pIdx < btnTexSize * btnTexSize; pIdx++) {
        const idx = pIdx * 4;
        const delta = baseDishDelta[pIdx];
        cImg.data[idx] = Math.min(255, Math.max(0, baseRGB[0] + delta));
        cImg.data[idx + 1] = Math.min(255, Math.max(0, baseRGB[1] + delta));
        cImg.data[idx + 2] = Math.min(255, Math.max(0, baseRGB[2] + delta));
        cImg.data[idx + 3] = 255;
      }
      cCtx.putImageData(cImg, 0, 0);

      let btnSeed = 9001 + labelIdx * 313;
      const btnRand = () => {
        btnSeed = (btnSeed * 16807) % 2147483647;
        return (btnSeed & 0xffff) / 0xffff;
      };
      for (let i = 0; i < 1400; i++) {
        const gx = btnRand() * btnTexSize;
        const gy = btnRand() * btnTexSize;
        const gRad = 0.7 + btnRand() * 1.45;
        const lightGrain = btnRand() > 0.52;
        const shift = lightGrain ? 14 : -15;
        cCtx.fillStyle = `rgba(${Math.min(255, Math.max(0, baseRGB[0] + shift))},${Math.min(
          255,
          Math.max(0, baseRGB[1] + shift)
        )},${Math.min(255, Math.max(0, baseRGB[2] + shift))},0.55)`;
        cCtx.beginPath();
        cCtx.arc(gx, gy, gRad, 0, Math.PI * 2);
        cCtx.fill();
      }

      // Subtle matte circular chamfer groove around the concave dish lip (aligned with dishUvMax = 0.38 -> 97px)
      cCtx.beginPath();
      cCtx.arc(btnCx, btnCy, 97, 0, Math.PI * 2);
      cCtx.strokeStyle = 'rgba(255, 255, 255, 0.13)';
      cCtx.lineWidth = 1.8;
      cCtx.stroke();

      cCtx.beginPath();
      cCtx.arc(btnCx, btnCy, 93, 0, Math.PI * 2);
      cCtx.strokeStyle = 'rgba(0, 0, 0, 0.5)';
      cCtx.lineWidth = 2.1;
      cCtx.stroke();

      // Realistic soft white LED-backlit character legend ("типо светодиодами белыми, чтобы не слепило")
      // 1) Laser-etched dark recess channel around the translucent white diffuser inlay
      cCtx.font = '700 96px "JetBrains Mono", monospace';
      cCtx.textAlign = 'center';
      cCtx.textBaseline = 'middle';

      cCtx.lineWidth = 5.5;
      cCtx.strokeStyle = 'rgba(8, 10, 14, 0.78)';
      cCtx.strokeText(label, btnCx, btnCy + 3);

      // 2) Subtle diffused white LED glow within the concave dish (soft, non-blinding)
      cCtx.save();
      cCtx.shadowColor = 'rgba(218, 234, 255, 0.42)';
      cCtx.shadowBlur = 8;
      cCtx.fillStyle = '#eef4ff';
      cCtx.fillText(label, btnCx, btnCy + 3);
      cCtx.restore();

      // 3) Crisp translucent milk-white LED diffuser core
      cCtx.fillStyle = '#f4f8ff';
      cCtx.fillText(label, btnCx, btnCy + 3);

      buttonCapCanvases.set(label, capCanvas);

      // Dedicated emissive map so ONLY the white LED character softly illuminates in 3D without glaring
      const emissiveCanvas = document.createElement('canvas');
      emissiveCanvas.width = btnTexSize;
      emissiveCanvas.height = btnTexSize;
      const eCtx = emissiveCanvas.getContext('2d')!;
      eCtx.fillStyle = '#000000';
      eCtx.fillRect(0, 0, btnTexSize, btnTexSize);
      eCtx.font = '700 96px "JetBrains Mono", monospace';
      eCtx.textAlign = 'center';
      eCtx.textBaseline = 'middle';
      eCtx.shadowColor = 'rgba(200, 222, 255, 0.65)';
      eCtx.shadowBlur = 7;
      eCtx.fillStyle = '#d8e6ff';
      eCtx.fillText(label, btnCx, btnCy + 3);

      const capTex = new THREE.CanvasTexture(capCanvas);
      capTex.colorSpace = THREE.SRGBColorSpace;
      capTex.anisotropy = maxAnisotropy;
      const emissiveTex = new THREE.CanvasTexture(emissiveCanvas);
      emissiveTex.colorSpace = THREE.SRGBColorSpace;
      emissiveTex.anisotropy = maxAnisotropy;
      if (isSoftwareGl) {
        capTex.generateMipmaps = false;
        capTex.minFilter = THREE.LinearFilter;
        emissiveTex.generateMipmaps = false;
        emissiveTex.minFilter = THREE.LinearFilter;
      }

      disposableButtonTextures.push(capTex, emissiveTex);

      const btnMat = createMat({
        color: 0xe2e5ec,
        map: capTex,
        bumpMap: optBump(sharedButtonBumpTex),
        bumpScale: 0.026,
        metalness: capMetal(0.26),
        roughness: 0.78,
        envMapIntensity: 0.32,
        emissive: new THREE.Color(0xdceaff),
        emissiveMap: isSoftwareGl ? undefined : emissiveTex,
        emissiveIntensity: 0.30,
      });

      sharedButtonMaterials.set(label, btnMat);
    });

    function buildIntercomModel(
      targetBrand: IntercomBrand,
      group: THREE.Group,
      bodyMat: THREE.Material,
      modelSubText: string
    ) {
      // 1. High-poly chamfered main faceplate body sitting inside the outer armor frame (front face at z = 0.089)
      // Cut a clean rectangular acoustic bay window behind upperInsert at (0.47, 0.732) so body bevels never pinch the 18 speaker tunnels
      const bodyShape = createRoundedRectShape(1.63, 2.91, 0.04);
      addSpeakerAcousticBayToBodyShape(bodyShape, 0.47, 0.732);
      const bodyGeo = new THREE.ExtrudeGeometry(bodyShape, {
        depth: 0.15,
        curveSegments: curveSegs,
        bevelEnabled: true,
        bevelThickness: 0.014,
        bevelSize: 0.012,
        bevelSegments: bevelSegs,
      });
      bodyGeo.center();
      const panel = new THREE.Mesh(bodyGeo, bodyMat);
      panel.position.set(0, 0.06, 0);
      panel.castShadow = true;
      panel.receiveShadow = true;
      group.add(panel);

      // 2. Recessed upper electronics faceplate insert (front face at z = 0.097, back face of speaker bores at z = 0.082)
      const upperInsertShape = createRoundedRectShape(1.44, 0.92, 0.028);
      addSpeakerHolesToShape(upperInsertShape, 0.47, -0.008, 0.0126);
      const upperInsertGeo = new THREE.ExtrudeGeometry(upperInsertShape, {
        depth: 0.015,
        curveSegments: curveSegs,
        bevelEnabled: false,
      });
      upperInsertGeo.center();
      const upperInsertMat = createMat({
        color: 0xffffff,
        map: darkInsertSurface.colorMap,
        metalness: capMetal(0.58),
        roughness: 0.52,
        bumpMap: optBump(darkInsertSurface.bumpMap),
        bumpScale: 0.012,
        polygonOffset: true,
        polygonOffsetFactor: -2,
        polygonOffsetUnits: -2,
      });
      const upperInsert = new THREE.Mesh(
        upperInsertGeo,
        isSoftwareGl ? upperInsertMat : [upperInsertMat, speakerGrilleMat]
      );
      upperInsert.position.set(0, 0.8, 0.0895);
      group.add(upperInsert);

      // 3. Embedded Upper Video Screen Module (front of bezel at z = 0.103, screen at z = 0.106)
      const monitorOuterBezel = new THREE.Mesh(
        new THREE.BoxGeometry(0.9, 0.48, 0.012),
        createMat({
          color: 0x0f1114,
          metalness: capMetal(0.75),
          roughness: 0.35,
        })
      );
      monitorOuterBezel.position.set(-0.2, 0.98, 0.097);
      group.add(monitorOuterBezel);

      const monitorScreen = new THREE.Mesh(
        new THREE.PlaneGeometry(0.82, 0.4),
        new THREE.MeshBasicMaterial({
          map: videoScreenTex,
          polygonOffset: true,
          polygonOffsetFactor: -2,
          polygonOffsetUnits: -2,
        })
      );
      monitorScreen.position.set(-0.2, 0.98, 0.106);
      monitorScreensByBrand[targetBrand] = monitorScreen;
      group.add(monitorScreen);

      // 4. Photorealistic Industrial Wide-Angle Intercom Camera Module with fisheye reflection & curved glass dome
      const camGroup = new THREE.Group();
      camGroup.position.set(0.47, 1.045, 0.099);

      const camOpticsDisc = new THREE.Mesh(
        new THREE.CircleGeometry(0.108, radialSegs),
        new THREE.MeshBasicMaterial({
          map: cameraOpticsTex,
          polygonOffset: true,
          polygonOffsetFactor: -2,
          polygonOffsetUnits: -2,
        })
      );
      camOpticsDisc.position.z = 0.005;
      camGroup.add(camOpticsDisc);

      // Curved convex glass dome over the fisheye camera lens so scene lights produce real 3D specular reflections
      const camGlassDome = new THREE.Mesh(
        new THREE.SphereGeometry(0.105, radialSegs, 20, 0, Math.PI * 2, 0, Math.PI * 0.24),
        createMat({
          color: 0x9ec5ff,
          metalness: capMetal(0.15),
          roughness: 0.08,
          transparent: true,
          opacity: 0.16,
          depthWrite: false,
        })
      );
      camGlassDome.rotation.x = Math.PI / 2;
      camGlassDome.scale.set(1, 0.24, 1);
      camGlassDome.position.z = -0.018;
      camGroup.add(camGlassDome);

      const camOuterRing = new THREE.Mesh(
        new THREE.TorusGeometry(0.11, 0.011, 24, radialSegs),
        createMat({
          color: 0x242830,
          metalness: capMetal(0.88),
          roughness: 0.25,
        })
      );
      camOuterRing.position.z = 0.007;
      camGroup.add(camOuterRing);

      const camInnerBarrelRing = new THREE.Mesh(
        new THREE.TorusGeometry(0.052, 0.0045, 20, radialSegs),
        createMat({
          color: 0x181c23,
          metalness: capMetal(0.9),
          roughness: 0.2,
        })
      );
      camInnerBarrelRing.position.z = 0.009;
      camGroup.add(camInnerBarrelRing);

      group.add(camGroup);

      // 5. Two-layer 3D Speaker Assembly behind the 18 cylindrical bores of upperInsert (z = 0.097 -> 0.082):
      //    - Back layer at z = 0.074: Dark-gray porous acoustic foam ("темно-серый поролон")
      //    - Front layer at z = 0.0815: Continuous 3D dark metallic woven wire mesh ("металлическая темная сетка")
      const speakerFoamPlane = new THREE.Mesh(speakerChamberGeo, speakerFoamMat);
      speakerFoamPlane.position.set(0.47, 0.792, 0.074);
      group.add(speakerFoamPlane);

      const speakerWireMeshPlane = new THREE.Mesh(speakerChamberGeo, speakerMeshMat);
      speakerWireMeshPlane.position.set(0.47, 0.792, 0.0815);
      group.add(speakerWireMeshPlane);

      if (!isSoftwareGl) {
        const sleevesGroup = new THREE.Group();
        sleevesGroup.position.set(0.47, 0.792, 0.0895);
        for (let r = 0; r < 3; r++) {
          for (let c = 0; c < 6; c++) {
            const hx = -0.125 + c * 0.05;
            const hy = -0.042 + r * 0.042;
            const sleeve = new THREE.Mesh(speakerBoreSleeveGeo, speakerBoreSleeveMat);
            sleeve.position.set(hx, hy, 0);
            sleevesGroup.add(sleeve);
          }
        }
        group.add(sleevesGroup);
      }

      // 6. 7-Segment LED Display Window (lower half of upper insert, bezel front at 0.103, screen at 0.106)
      const dispBezel = new THREE.Mesh(
        new THREE.BoxGeometry(0.9, 0.3, 0.012),
        createMat({
          color: 0x0b0c0e,
          metalness: capMetal(0.65),
          roughness: 0.4,
        })
      );
      dispBezel.position.set(-0.2, 0.53, 0.097);
      group.add(dispBezel);

      const dispScreen = new THREE.Mesh(
        new THREE.PlaneGeometry(0.82, 0.22),
        new THREE.MeshBasicMaterial({
          map: displayTex,
          polygonOffset: true,
          polygonOffsetFactor: -2,
          polygonOffsetUnits: -2,
        })
      );
      dispScreen.position.set(-0.2, 0.53, 0.106);
      group.add(dispScreen);

      // 7. RFID / Dallas Touch Memory Key Contactor
      const rfidGroup = new THREE.Group();
      rfidGroup.position.set(0.47, 0.53, 0.099);

      const rfidInsulator = new THREE.Mesh(
        new THREE.CircleGeometry(0.112, radialSegs),
        createMat({ color: 0x111316, roughness: 0.7, metalness: 0.2 })
      );
      rfidInsulator.position.z = 0.003;
      rfidGroup.add(rfidInsulator);

      const rfidOuterBezel = new THREE.Mesh(
        new THREE.TorusGeometry(0.122, 0.016, 24, radialSegs),
        createMat({
          color: 0x858b94,
          metalness: capMetal(0.92),
          roughness: 0.18,
        })
      );
      rfidOuterBezel.position.z = 0.006;
      rfidGroup.add(rfidOuterBezel);

      const rfidContactCore = new THREE.Mesh(
        new THREE.CylinderGeometry(0.082, 0.082, 0.008, radialSegs),
        createMat({
          color: 0xcbd0d8,
          metalness: capMetal(0.94),
          roughness: 0.18,
          bumpMap: optBump(armorSurface.bumpMap),
          bumpScale: 0.004,
        })
      );
      rfidContactCore.rotation.x = Math.PI / 2;
      rfidContactCore.position.z = 0.009;
      rfidGroup.add(rfidContactCore);

      group.add(rfidGroup);

      // 8. Four Corner Anti-Vandal Security Screws
      const screwOuterGeo = new THREE.CylinderGeometry(0.038, 0.038, 0.012, 36);
      const screwOuterMat = createMat({
        color: 0x70757f,
        metalness: capMetal(0.9),
        roughness: 0.22,
      });
      const screwSocketGeo = new THREE.CircleGeometry(0.017, 6);
      const screwSocketMat = new THREE.MeshBasicMaterial({ color: 0x1a1c20 });

      [
        [-0.68, 1.38],
        [0.68, 1.38],
        [-0.68, -1.26],
        [0.68, -1.26],
      ].forEach(([sx, sy]) => {
        const screw = new THREE.Mesh(screwOuterGeo, screwOuterMat);
        screw.rotation.x = Math.PI / 2;
        screw.position.set(sx, sy, 0.092);
        group.add(screw);

        const socket = new THREE.Mesh(screwSocketGeo, screwSocketMat);
        socket.position.set(sx, sy, 0.100);
        group.add(socket);
      });

      // 9. 12 Tactile Concave Metal Buttons ('1'-'9', 'C', '0', 'B') mounted directly into the main intercom faceplate (no protruding background plate)
      KEY_LABELS.forEach((label, i) => {
        const x = (i % 3) * 0.41 - 0.41;
        const y = -Math.floor(i / 3) * 0.335 + 0.07;

        const socketHole = new THREE.Mesh(socketHoleGeo, socketHoleMat);
        socketHole.position.set(x, y, 0.090);
        group.add(socketHole);

        const rim = new THREE.Mesh(rimGeo, rimMat);
        rim.position.set(x, y, 0.091);
        group.add(rim);

        const btnWrap = new THREE.Group();
        const btnMat = sharedButtonMaterials.get(label)!;

        // Unified high-poly concave button with arc-length UV textured sides & soft white LED character
        const btnMesh = new THREE.Mesh(concaveBtnGeo, btnMat);
        btnMesh.userData = { label, baseZ: BTN_REST_Z };
        btnWrap.add(btnMesh);

        btnWrap.position.set(x, y, BTN_REST_Z);
        btnWrap.userData = { restZ: BTN_REST_Z, pressedZ: BTN_PRESSED_Z };
        group.add(btnWrap);

        buttonsByBrand[targetBrand].push(btnMesh);
        buttonWrapMap[targetBrand].set(label, btnWrap);
      });

      // 10. Distinct Stylized Brand Nameplate & Model Spec Silkscreen
      const logoCanvas = document.createElement('canvas');
      logoCanvas.width = 512;
      logoCanvas.height = 72;
      const lCtx = logoCanvas.getContext('2d')!;
      drawBrandNameplate(lCtx, targetBrand, modelSubText);
      brandLogoCanvases[targetBrand] = logoCanvas;

      const logoTex = new THREE.CanvasTexture(logoCanvas);
      logoTex.colorSpace = THREE.SRGBColorSpace;
      logoTex.anisotropy = maxAnisotropy;
      if (isSoftwareGl) {
        logoTex.generateMipmaps = false;
        logoTex.minFilter = THREE.LinearFilter;
      }

      const logoPlane = new THREE.Mesh(
        new THREE.PlaneGeometry(1.06, 0.14),
        new THREE.MeshBasicMaterial({
          map: logoTex,
          transparent: true,
          depthWrite: false,
          polygonOffset: true,
          polygonOffsetFactor: -2,
          polygonOffsetUnits: -2,
        })
      );
      logoPlane.position.set(0, 1.38, 0.099);
      group.add(logoPlane);
    }

    // 1. ELTIS: Fine graphite powder-coated stipple ("мелкая порошковая шагрень")
    const eltisBodyMat = createMat({
      color: 0xffffff,
      map: eltisSurface.colorMap,
      metalness: capMetal(0.56),
      roughness: 0.66,
      bumpMap: optBump(eltisSurface.bumpMap),
      bumpScale: 0.018,
    });
    buildIntercomModel('eltis', brandGroups.eltis, eltisBodyMat, 'DP400-T');
    scene.add(brandGroups.eltis);

    // 2. VIZIT: Warm champagne-copper directional micro-bead-blasted satin metallic
    const vizitBodyMat = createMat({
      color: 0xffffff,
      map: vizitSurface.colorMap,
      metalness: capMetal(0.76),
      roughness: 0.36,
      bumpMap: optBump(vizitSurface.bumpMap),
      bumpScale: 0.011,
    });
    buildIntercomModel('vizit', brandGroups.vizit, vizitBodyMat, 'BVD-343F');
    scene.add(brandGroups.vizit);

    // 3. CYFRAL: Coarse hammered bronze-umber cellular relief ("крупная молотковая эмаль")
    const cyfralBodyMat = createMat({
      color: 0xffffff,
      map: cyfralSurface.colorMap,
      metalness: capMetal(0.68),
      roughness: 0.48,
      bumpMap: optBump(cyfralSurface.bumpMap),
      bumpScale: 0.032,
    });
    buildIntercomModel('cyfral', brandGroups.cyfral, cyfralBodyMat, 'CCD-2094');
    scene.add(brandGroups.cyfral);

    if (!isSoftwareGl && renderer) {
      renderer.compile(scene, camera);
    }

    let currentBrandInternal: IntercomBrand = brand;
    let frameId = 0;
    let renderBusy = false;
    let renderDirty = false;
    let unmounted = false;

    // Monotonic, jitter-free button depression state per key ('1'-'9', 'C', '0', 'B')
    const buttonAnimMap = new Map<
      string,
      { currentZ: number; targetZ: number; holdUntil: number }
    >();
    KEY_LABELS.forEach((lbl) => {
      buttonAnimMap.set(lbl, {
        currentZ: BTN_REST_Z,
        targetZ: BTN_REST_Z,
        holdUntil: 0,
      });
    });
    let heldButtonLabel: string | null = null;

    function stepButtonAnimations(now: number): boolean {
      let anyMoving = false;
      buttonAnimMap.forEach((st, lbl) => {
        if (st.holdUntil > 0 && st.holdUntil !== Infinity && now >= st.holdUntil) {
          st.holdUntil = 0;
          st.targetZ = BTN_REST_Z;
        }
        const diff = st.targetZ - st.currentZ;
        if (Math.abs(diff) > 0.00015) {
          // Smooth single-direction exponential ease (fast press-in, smooth realistic spring return, zero oscillation)
          const factor = st.targetZ < st.currentZ ? 0.55 : 0.34;
          st.currentZ += diff * factor;
          if (Math.abs(st.targetZ - st.currentZ) <= 0.0002) {
            st.currentZ = st.targetZ;
          } else {
            anyMoving = true;
          }
          (['eltis', 'vizit', 'cyfral'] as IntercomBrand[]).forEach((b) => {
            const wrap = buttonWrapMap[b].get(lbl);
            if (wrap) wrap.position.z = st.currentZ;
          });
        } else if (st.holdUntil > 0 && st.holdUntil !== Infinity) {
          anyMoving = true;
        }
      });
      return anyMoving;
    }

    const projV00 = new THREE.Vector3();
    const projV10 = new THREE.Vector3();
    const projV01 = new THREE.Vector3();

    function renderSoftwareScene() {
      if (!softCanvas) return;
      const ctx = softCanvas.getContext('2d');
      if (!ctx) return;

      scene.updateMatrixWorld();
      camera.updateMatrixWorld();

      const cw = softCanvas.width;
      const ch = softCanvas.height;

      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.fillStyle = '#0b0c0e';
      ctx.fillRect(0, 0, cw, ch);

      // Tangent-plane projection locked at (0, 0.06, cz) so all co-planar features (body, screws, buttons, speaker holes)
      // never drift relative to each other under perspective rotation!
      const applyPlaneTransform = (cx: number, cy: number, cz: number, _w: number, _h: number) => {
        const eps = 0.25;
        const refX = 0;
        const refY = 0.06;
        projV00.set(refX, refY, cz).project(camera);
        projV10.set(refX + eps, refY, cz).project(camera);
        projV01.set(refX, refY - eps, cz).project(camera);

        const x0 = (projV00.x * 0.5 + 0.5) * cw;
        const y0 = (-projV00.y * 0.5 + 0.5) * ch;
        const x10 = (projV10.x * 0.5 + 0.5) * cw;
        const y10 = (-projV10.y * 0.5 + 0.5) * ch;
        const x01 = (projV01.x * 0.5 + 0.5) * cw;
        const y01 = (-projV01.y * 0.5 + 0.5) * ch;

        const a = (x10 - x0) / eps;
        const b = (y10 - y0) / eps;
        const c = (x01 - x0) / eps;
        const d = (y01 - y0) / eps;

        const dx = cx - refX;
        const dy = -(cy - refY);
        ctx.setTransform(a, b, c, d, x0 + a * dx + c * dy, y0 + b * dx + d * dy);
      };

      const traceRoundedRect = (w: number, h: number, r: number) => {
        const x = -w / 2;
        const y = -h / 2;
        ctx.beginPath();
        ctx.moveTo(x + r, y);
        ctx.lineTo(x + w - r, y);
        ctx.quadraticCurveTo(x + w, y, x + w, y + r);
        ctx.lineTo(x + w, y + h - r);
        ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
        ctx.lineTo(x + r, y + h);
        ctx.quadraticCurveTo(x, y + h, x, y + h - r);
        ctx.lineTo(x, y + r);
        ctx.quadraticCurveTo(x, y, x + r, y);
        ctx.closePath();
      };

      const drawTexturedRoundedPlane = (
        cx: number,
        cy: number,
        cz: number,
        w: number,
        h: number,
        r: number,
        img: HTMLCanvasElement,
        strokeColor: string,
        lineWidth: number
      ) => {
        ctx.save();
        applyPlaneTransform(cx, cy, cz, w, h);
        traceRoundedRect(w, h, r);
        ctx.clip();
        // Draw square isotropic tiles so the surface relief is crisp and never stretched vertically
        const tileSize = Math.min(w, 0.85);
        for (let ty = -h / 2; ty < h / 2; ty += tileSize) {
          for (let tx = -w / 2; tx < w / 2; tx += tileSize) {
            ctx.drawImage(img, tx, ty, tileSize + 0.004, tileSize + 0.004);
          }
        }
        ctx.strokeStyle = strokeColor;
        ctx.lineWidth = lineWidth;
        ctx.stroke();
        ctx.restore();
      };

      // 1. Door backdrop & weatherproof rubber gasket
      ctx.save();
      applyPlaneTransform(0, 0.06, -0.1, 2.12, 3.36);
      traceRoundedRect(2.12, 3.36, 0.14);
      ctx.fillStyle = '#131518';
      ctx.fill();
      ctx.strokeStyle = '#1f2329';
      ctx.lineWidth = 0.015;
      ctx.stroke();
      ctx.restore();

      ctx.save();
      applyPlaneTransform(0, 0.06, -0.05, 1.92, 3.18);
      traceRoundedRect(1.92, 3.18, 0.11);
      ctx.fillStyle = '#090a0b';
      ctx.fill();
      ctx.restore();

      // 2. Outer die-cast armor surround frame
      drawTexturedRoundedPlane(
        0,
        0.06,
        0.06,
        1.85,
        3.11,
        0.095,
        armorSurface.colorMap.image as HTMLCanvasElement,
        'rgba(255,255,255,0.18)',
        0.018
      );

      // Smooth upper visor arch
      drawTexturedRoundedPlane(
        0,
        1.565,
        0.11,
        1.74,
        0.075,
        0.03,
        armorSurface.colorMap.image as HTMLCanvasElement,
        'rgba(255,255,255,0.22)',
        0.012
      );

      // 3. Active brand faceplate body
      const activeBodySurface =
        currentBrandInternal === 'vizit'
          ? vizitSurface
          : currentBrandInternal === 'cyfral'
            ? cyfralSurface
            : eltisSurface;

      drawTexturedRoundedPlane(
        0,
        0.06,
        0.089,
        1.63,
        2.91,
        0.04,
        activeBodySurface.colorMap.image as HTMLCanvasElement,
        'rgba(0,0,0,0.55)',
        0.016
      );

      // 4. Stylized Brand Nameplate
      const logoImg = brandLogoCanvases[currentBrandInternal];
      if (logoImg) {
        ctx.save();
        applyPlaneTransform(0, 1.38, 0.096, 1.06, 0.14);
        ctx.drawImage(logoImg, -1.06 / 2, -0.14 / 2, 1.06, 0.14);
        ctx.restore();
      }

      // 5. Recessed upper electronics faceplate insert
      drawTexturedRoundedPlane(
        0,
        0.8,
        0.093,
        1.44,
        0.92,
        0.028,
        darkInsertSurface.colorMap.image as HTMLCanvasElement,
        'rgba(255,255,255,0.1)',
        0.01
      );

      // 6. Embedded Upper Video Screen Module
      ctx.save();
      applyPlaneTransform(-0.2, 0.98, 0.098, 0.9, 0.48);
      ctx.fillStyle = '#0f1114';
      ctx.fillRect(-0.45, -0.24, 0.9, 0.48);
      ctx.strokeStyle = 'rgba(255,255,255,0.14)';
      ctx.lineWidth = 0.008;
      ctx.strokeRect(-0.45, -0.24, 0.9, 0.48);
      ctx.restore();

      ctx.save();
      applyPlaneTransform(-0.2, 0.98, 0.104, 0.82, 0.4);
      ctx.drawImage(videoScreenCanvas, -0.41, -0.2, 0.82, 0.4);
      ctx.restore();

      // 7. Industrial Wide-Angle Intercom Camera Module with live reflection
      ctx.save();
      applyPlaneTransform(0.47, 1.045, 0.102, 0.24, 0.24);
      ctx.beginPath();
      ctx.arc(0, 0, 0.118, 0, Math.PI * 2);
      ctx.fillStyle = '#242830';
      ctx.fill();
      ctx.strokeStyle = 'rgba(255,255,255,0.22)';
      ctx.lineWidth = 0.008;
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(0, 0, 0.106, 0, Math.PI * 2);
      ctx.clip();
      ctx.drawImage(cameraOpticsCanvas, -0.108, -0.108, 0.216, 0.216);
      ctx.restore();

      // 8. Cylindrical Speaker Bores with 3D Dark Metallic Wire Mesh in front of Dark-Gray Acoustic Foam
      {
        const camDx = THREE.MathUtils.clamp((camera.position.x - controls.target.x) / 3.2, -1, 1);
        const camDy = THREE.MathUtils.clamp((camera.position.y - controls.target.y) / 3.2, -1, 1);
        ctx.save();
        applyPlaneTransform(0.47, 0.792, 0.097, 0.34, 0.15);
        for (let r = 0; r < 3; r++) {
          for (let c = 0; c < 6; c++) {
            const hx = -0.125 + c * 0.05;
            const hy = 0.042 - r * 0.042;
            const holeR = 0.0126;

            ctx.save();
            ctx.beginPath();
            ctx.arc(hx, hy, holeR, 0, Math.PI * 2);
            ctx.clip();

            // 1. Machined cylindrical metal bore wall around the rim
            ctx.fillStyle = '#1e232c';
            ctx.fillRect(hx - holeR, hy - holeR, holeR * 2, holeR * 2);

            // 2. Back layer (deeper parallax): Dark-gray porous acoustic foam ("темно-серый поролон")
            const foamOx = (-0.0012 - camDx * 0.0065);
            const foamOy = (-0.0012 + camDy * 0.0065);
            const boreOx = (-0.0008 - camDx * 0.0038);
            const boreOy = (-0.0008 + camDy * 0.0038);

            ctx.save();
            ctx.beginPath();
            ctx.arc(hx + boreOx, hy + boreOy, holeR * 0.95, 0, Math.PI * 2);
            ctx.clip();
            ctx.drawImage(
              speakerInternalSurface.foamCanvas,
              -0.17 + foamOx,
              -0.075 + foamOy,
              0.34,
              0.15
            );

            // 3. Front layer (closer parallax): 3D Dark Metallic Woven Wire Mesh ("металлическая темная сетка")
            ctx.drawImage(
              speakerInternalSurface.meshCanvas,
              -0.17 + boreOx,
              -0.075 + boreOy,
              0.34,
              0.15
            );
            ctx.restore();

            // 4. Subtle top-left rim shadow inside the cylindrical mouth
            ctx.beginPath();
            ctx.arc(hx + 0.0015, hy + 0.0015, holeR, 0, Math.PI * 2);
            ctx.lineWidth = 0.0022;
            ctx.strokeStyle = 'rgba(0, 0, 0, 0.78)';
            ctx.stroke();
            ctx.restore();

            // Crisp cylindrical rim edge highlight flush with the faceplate mouth
            ctx.beginPath();
            ctx.arc(hx, hy, holeR, 0.15 * Math.PI, 0.85 * Math.PI);
            ctx.lineWidth = 0.0015;
            ctx.strokeStyle = 'rgba(255, 255, 255, 0.24)';
            ctx.stroke();
          }
        }
        ctx.restore();
      }

      // 9. 7-Segment LED Display Window
      ctx.save();
      applyPlaneTransform(-0.2, 0.53, 0.098, 0.9, 0.3);
      ctx.fillStyle = '#0b0c0e';
      ctx.fillRect(-0.45, -0.15, 0.9, 0.3);
      ctx.strokeStyle = 'rgba(255,255,255,0.12)';
      ctx.lineWidth = 0.008;
      ctx.strokeRect(-0.45, -0.15, 0.9, 0.3);
      ctx.restore();

      ctx.save();
      applyPlaneTransform(-0.2, 0.53, 0.104, 0.82, 0.22);
      ctx.drawImage(displayCanvas, -0.41, -0.11, 0.82, 0.22);
      ctx.restore();

      // 10. RFID / Dallas Touch Memory Key Contactor
      ctx.save();
      applyPlaneTransform(0.47, 0.53, 0.102, 0.26, 0.26);
      ctx.beginPath();
      ctx.arc(0, 0, 0.126, 0, Math.PI * 2);
      ctx.fillStyle = '#858b94';
      ctx.fill();
      ctx.beginPath();
      ctx.arc(0, 0, 0.108, 0, Math.PI * 2);
      ctx.fillStyle = '#111316';
      ctx.fill();
      ctx.beginPath();
      ctx.arc(0, 0, 0.082, 0, Math.PI * 2);
      ctx.fillStyle = '#cbd0d8';
      ctx.fill();
      ctx.restore();

      // 11. Four Corner Security Screws
      [
        [-0.68, 1.38],
        [0.68, 1.38],
        [-0.68, -1.26],
        [0.68, -1.26],
      ].forEach(([sx, sy]) => {
        ctx.save();
        applyPlaneTransform(sx, sy, 0.091, 0.08, 0.08);
        ctx.beginPath();
        ctx.arc(0, 0, 0.038, 0, Math.PI * 2);
        ctx.fillStyle = '#70757f';
        ctx.fill();
        ctx.beginPath();
        ctx.arc(0, 0, 0.017, 0, Math.PI * 2);
        ctx.fillStyle = '#1a1c20';
        ctx.fill();
        ctx.restore();
      });

      // 12. 12 Tactile 3D Concave Metal Keypad Buttons mounted directly on the main faceplate (no background plate)
      KEY_LABELS.forEach((label, i) => {
        const bx = (i % 3) * 0.41 - 0.41;
        const by = -Math.floor(i / 3) * 0.335 + 0.07;
        const wrap = buttonWrapMap[currentBrandInternal].get(label);
        const btnZ = wrap ? wrap.position.z : BTN_REST_Z;
        const capImg = buttonCapCanvases.get(label);

        // Socket hole + machined outer collar bezel at z = 0.092
        ctx.save();
        applyPlaneTransform(bx, by, 0.092, 0.26, 0.26);
        ctx.beginPath();
        ctx.arc(0, 0, 0.128, 0, Math.PI * 2);
        ctx.fillStyle = '#4e5460';
        ctx.fill();
        ctx.strokeStyle = 'rgba(255,255,255,0.14)';
        ctx.lineWidth = 0.006;
        ctx.stroke();

        ctx.beginPath();
        ctx.arc(0, 0, 0.112, 0, Math.PI * 2);
        ctx.fillStyle = '#050608';
        ctx.fill();
        ctx.restore();

        // Multi-slice 3D cylindrical side wall from z = 0.095 up to btnZ + 0.015 with unstretched sandblasted texture!
        if (capImg) {
          const sideSlices = [0.001, 0.006, 0.011, 0.015];
          for (let sIdx = 0; sIdx < sideSlices.length; sIdx++) {
            const sz = btnZ + sideSlices[sIdx];
            const sr = sIdx === sideSlices.length - 1 ? 0.098 : 0.105;
            ctx.save();
            applyPlaneTransform(bx, by, sz, 0.214, 0.214);
            ctx.beginPath();
            ctx.arc(0, 0, sr, 0, Math.PI * 2);
            ctx.clip();
            ctx.drawImage(capImg, -0.106, -0.106, 0.212, 0.212);
            ctx.fillStyle = sIdx < 2 ? 'rgba(0,0,0,0.28)' : 'rgba(0,0,0,0.14)';
            ctx.fillRect(-0.106, -0.106, 0.212, 0.212);
            ctx.restore();
          }
        }

        // 3D Concave sandblasted top dish with white LED backlit character at live depth btnZ + 0.018
        if (capImg) {
          ctx.save();
          applyPlaneTransform(bx, by, btnZ + 0.018, 0.182, 0.182);
          ctx.beginPath();
          ctx.arc(0, 0, 0.088, 0, Math.PI * 2);
          ctx.clip();
          ctx.drawImage(capImg, -0.114, -0.114, 0.228, 0.228);
          ctx.restore();
        }
      });

      // Night mode overlay in software renderer: dim metallic surfaces while keeping LEDs, screen & backlit keys glowing!
      if (livePropsRef.current.isNightMode) {
        ctx.save();
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.fillStyle = 'rgba(1, 3, 7, 0.76)';
        ctx.fillRect(0, 0, cw, ch);
        ctx.restore();

        // Re-render illuminated screens & glowing white LED keypad legends in darkness
        ctx.save();
        applyPlaneTransform(-0.2, 0.98, 0.104, 0.82, 0.4);
        ctx.drawImage(videoScreenCanvas, -0.41, -0.2, 0.82, 0.4);
        ctx.restore();

        ctx.save();
        applyPlaneTransform(-0.2, 0.53, 0.104, 0.82, 0.22);
        ctx.drawImage(displayCanvas, -0.41, -0.11, 0.82, 0.22);
        ctx.restore();

        KEY_LABELS.forEach((label, i) => {
          const bx = (i % 3) * 0.41 - 0.41;
          const by = -Math.floor(i / 3) * 0.335 + 0.07;
          const wrap = buttonWrapMap[currentBrandInternal].get(label);
          const btnZ = wrap ? wrap.position.z : BTN_REST_Z;
          ctx.save();
          applyPlaneTransform(bx, by, btnZ + 0.0185, 0.182, 0.182);
          ctx.font = '700 0.086px "JetBrains Mono", monospace';
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.shadowColor = 'rgba(210, 230, 255, 0.85)';
          ctx.shadowBlur = 10;
          ctx.fillStyle = '#eef5ff';
          ctx.fillText(label, 0, 0.003);
          ctx.restore();
        });
      }

      ctx.setTransform(1, 0, 0, 1, 0, 0);
    }

    const prevCamPos = new THREE.Vector3().copy(camera.position);
    const prevTargetPos = new THREE.Vector3().copy(controls.target);

    function requestRender() {
      if (unmounted) return;
      if (renderBusy) {
        renderDirty = true;
        return;
      }
      renderBusy = true;
      frameId = requestAnimationFrame((now) => {
        if (unmounted) return;
        renderDirty = false;
        if (controls.enabled && controls.enableDamping) {
          controls.update();
        }
        enforceCameraOutsideIntercom();
        const camMoved =
          prevCamPos.distanceToSquared(camera.position) > 1e-7 ||
          prevTargetPos.distanceToSquared(controls.target) > 1e-7;
        prevCamPos.copy(camera.position);
        prevTargetPos.copy(controls.target);

        const buttonsMoving = stepButtonAnimations(now);
        if (isSoftwareGl) {
          renderSoftwareScene();
        } else if (renderer) {
          renderer.render(scene, camera);
        }
        renderBusy = false;
        if (renderDirty || buttonsMoving || camMoved) {
          requestRender();
        }
      });
    }

    controls.addEventListener('change', () => {
      enforceCameraOutsideIntercom();
      const camDx = THREE.MathUtils.clamp((camera.position.x - controls.target.x) / 3.2, -1, 1);
      const camDy = THREE.MathUtils.clamp((camera.position.y - controls.target.y) / 3.2, -1, 1);
      renderCameraOpticsCanvas(
        cameraOpticsCanvas,
        localVideoElementRef?.current,
        livePropsRef.current.camEnabled,
        livePropsRef.current.mirrorLocalVideo,
        camDx,
        camDy
      );
      cameraOpticsTex.needsUpdate = true;
      requestRender();
    });

    function drawDisplay(text: string, b: IntercomBrand) {
      const ctx = displayCanvas.getContext('2d')!;
      const ledColor = BRAND_SPECS[b].ledColor;
      ctx.fillStyle = '#080404';
      ctx.fillRect(0, 0, displayCanvas.width, displayCanvas.height);

      ctx.save();
      ctx.fillStyle = ledColor;
      ctx.shadowBlur = 8;
      ctx.shadowColor = ledColor;
      ctx.font = '700 52px "JetBrains Mono", monospace';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(text.slice(0, 7), 128, 50);
      ctx.restore();

      displayTex.needsUpdate = true;
      requestRender();
    }

    // Helper to draw an image/video with rotation & full-bleed cover/contain fit inside a target box
    function drawMediaAspectFit(
      ctx: CanvasRenderingContext2D,
      media: HTMLVideoElement | HTMLCanvasElement,
      dx: number,
      dy: number,
      dw: number,
      dh: number,
      mirror: boolean,
      rotationDeg: 0 | 90 | 180 | 270 = 0,
      fitMode: 'contain' | 'cover' = 'cover'
    ) {
      const sw =
        media instanceof HTMLVideoElement ? media.videoWidth || 320 : media.width || 320;
      const sh =
        media instanceof HTMLVideoElement ? media.videoHeight || 240 : media.height || 240;
      if (sw <= 0 || sh <= 0) return;

      const isQuarterTurn = rotationDeg === 90 || rotationDeg === 270;

      ctx.save();
      ctx.beginPath();
      ctx.rect(dx, dy, dw, dh);
      ctx.clip();

      ctx.translate(dx + dw / 2, dy + dh / 2);
      if (rotationDeg !== 0) {
        ctx.rotate((rotationDeg * Math.PI) / 180);
      }
      if (mirror) {
        ctx.scale(-1, 1);
      }

      const availW = isQuarterTurn ? dh : dw;
      const availH = isQuarterTurn ? dw : dh;

      if (fitMode === 'contain') {
        const scale = Math.min(availW / sw, availH / sh);
        const drawW = sw * scale;
        const drawH = sh * scale;
        ctx.drawImage(media, 0, 0, sw, sh, -drawW / 2, -drawH / 2, drawW, drawH);
      } else {
        const srcAspect = sw / sh;
        const dstAspect = availW / availH;
        let sx = 0;
        let sy = 0;
        let sWidth = sw;
        let sHeight = sh;

        if (srcAspect > dstAspect) {
          sWidth = sh * dstAspect;
          sx = (sw - sWidth) / 2;
        } else {
          sHeight = sw / dstAspect;
          sy = (sh - sHeight) / 2;
        }
        ctx.drawImage(media, sx, sy, sWidth, sHeight, -availW / 2, -availH / 2, availW, availH);
      }
      ctx.restore();
    }

    function drawVideoScreenNow() {
      const ctx = videoScreenCanvas.getContext('2d')!;
      const w = videoScreenCanvas.width; // 512
      const h = videoScreenCanvas.height; // 320

      const {
        brand: b,
        isCallConnected: connected,
        peerPin: pin,
        myPin: selfPin,
        camEnabled: isCamOn,
        micEnabled: isMicOn,
        peerMicEnabled: isPeerMicOn,
        peerCamEnabled: isPeerCamOn,
        mirrorLocalVideo: mirrorSelf,
        showSelfPreview: showSelf,
        remoteRotation: rotMode,
        baselinePeerIsPortrait: basePortrait,
      } = livePropsRef.current;

      const localVideo = localVideoElementRef?.current;
      const remoteVideo = remoteVideoElementRef?.current;
      const remoteCanvas = remoteVideoCanvasRef?.current;

      // Update the 3D intercom's circular optical camera lens with a darkened fisheye reflection & dynamic light glare!
      const camDx = THREE.MathUtils.clamp((camera.position.x - controls.target.x) / 3.2, -1, 1);
      const camDy = THREE.MathUtils.clamp((camera.position.y - controls.target.y) / 3.2, -1, 1);
      renderCameraOpticsCanvas(cameraOpticsCanvas, localVideo, isCamOn, mirrorSelf, camDx, camDy);
      cameraOpticsTex.needsUpdate = true;

      ctx.fillStyle = '#090b0e';
      ctx.fillRect(0, 0, w, h);

      if (connected) {
        let drewRemote = false;
        if (isPeerCamOn && remoteVideo && remoteVideo.readyState >= 2 && remoteVideo.videoWidth > 0) {
          try {
            const effRot = resolveEffectiveRotation(
              rotMode,
              remoteVideo.videoWidth,
              remoteVideo.videoHeight,
              w,
              h,
              basePortrait
            );
            drawMediaAspectFit(
              ctx,
              remoteVideo,
              0,
              0,
              w,
              h,
              false,
              effRot,
              'cover'
            );
            drewRemote = true;
          } catch {
            // Ignore
          }
        }
        if (isPeerCamOn && !drewRemote && remoteCanvas) {
          try {
            const effRot = resolveEffectiveRotation(
              rotMode,
              remoteCanvas.width,
              remoteCanvas.height,
              w,
              h,
              basePortrait
            );
            drawMediaAspectFit(ctx, remoteCanvas, 0, 0, w, h, false, effRot, 'cover');
            drewRemote = true;
          } catch {
            // Ignore
          }
        }
        if (!isPeerCamOn) {
          ctx.fillStyle = '#0b0d12';
          ctx.fillRect(0, 0, w, h);
          ctx.fillStyle = '#9ca3af';
          ctx.font = '700 18px "JetBrains Mono", monospace';
          ctx.textAlign = 'center';
          ctx.fillText(`АБОНЕНТ #${pin || '---'} · КАМЕРА ВЫКЛ`, w / 2, h / 2 + 10);
        }

        // Small status icons in top-left of intercom window when remote peer turns off mic or camera
        if (!isPeerMicOn || !isPeerCamOn) {
          let badgeX = 12;
          const badgeY = 46;
          if (!isPeerMicOn) {
            ctx.save();
            ctx.fillStyle = 'rgba(12, 14, 18, 0.86)';
            ctx.strokeStyle = '#7f1d1d';
            ctx.lineWidth = 1.5;
            ctx.beginPath();
            ctx.roundRect(badgeX, badgeY, 28, 24, 5);
            ctx.fill();
            ctx.stroke();

            // Small muted microphone vector icon
            const mx = badgeX + 14;
            const my = badgeY + 12;
            ctx.strokeStyle = '#f87171';
            ctx.lineWidth = 1.8;
            ctx.beginPath();
            ctx.roundRect(mx - 3, my - 6.5, 6, 9, 3);
            ctx.stroke();
            ctx.beginPath();
            ctx.arc(mx, my - 1.5, 5.5, 0, Math.PI);
            ctx.stroke();
            ctx.beginPath();
            ctx.moveTo(mx, my + 4);
            ctx.lineTo(mx, my + 7);
            ctx.moveTo(mx - 6, my - 6);
            ctx.lineTo(mx + 6, my + 6);
            ctx.stroke();
            ctx.restore();
            badgeX += 34;
          }
          if (!isPeerCamOn) {
            ctx.save();
            ctx.fillStyle = 'rgba(12, 14, 18, 0.86)';
            ctx.strokeStyle = '#7f1d1d';
            ctx.lineWidth = 1.5;
            ctx.beginPath();
            ctx.roundRect(badgeX, badgeY, 28, 24, 5);
            ctx.fill();
            ctx.stroke();

            // Small camera-off vector icon
            const vx = badgeX + 14;
            const vy = badgeY + 12;
            ctx.strokeStyle = '#f87171';
            ctx.lineWidth = 1.8;
            ctx.strokeRect(vx - 6.5, vy - 4.5, 9.5, 9);
            ctx.beginPath();
            ctx.moveTo(vx + 3, vy - 2);
            ctx.lineTo(vx + 7, vy - 4.5);
            ctx.lineTo(vx + 7, vy + 4.5);
            ctx.lineTo(vx + 3, vy + 2);
            ctx.closePath();
            ctx.stroke();
            ctx.beginPath();
            ctx.moveTo(vx - 7, vy - 6);
            ctx.lineTo(vx + 7, vy + 6);
            ctx.stroke();
            ctx.restore();
          }
        }
      } else {
        ctx.strokeStyle = 'rgba(255,255,255,0.035)';
        ctx.lineWidth = 1;
        for (let y = 36; y < h; y += 28) {
          ctx.beginPath();
          ctx.moveTo(0, y);
          ctx.lineTo(w, y);
          ctx.stroke();
        }

        ctx.fillStyle = '#e5e7eb';
        ctx.font = '700 24px "JetBrains Mono", monospace';
        ctx.textAlign = 'left';
        ctx.fillText(BRAND_SPECS[b].fullName, 20, h - 54);

        ctx.fillStyle = '#9ca3af';
        ctx.font = '600 18px "JetBrains Mono", monospace';
        ctx.fillText(`LINE #${selfPin || '---'}`, 20, h - 24);
      }

      // Draggable & Toggleable Self-Preview Window ("окошечко с собой") on the 3D intercom screen
      if (showSelf) {
        const pip = pipStateRef.current;
        const px = Math.max(8, Math.min(w - pip.w - 8, pip.x));
        const py = Math.max(44, Math.min(h - pip.h - 8, pip.y));
        pip.x = px;
        pip.y = py;

        ctx.fillStyle = 'rgba(8, 10, 14, 0.96)';
        ctx.fillRect(px - 2, py - 2, pip.w + 4, pip.h + 4);

        if (isCamOn && localVideo && localVideo.readyState >= 2) {
          try {
            drawMediaAspectFit(ctx, localVideo, px, py, pip.w, pip.h, mirrorSelf, 0, 'cover');
          } catch {
            // Ignore
          }
        } else if (isCamOn) {
          const sGrad = ctx.createRadialGradient(
            px + pip.w / 2,
            py + pip.h * 0.45,
            8,
            px + pip.w / 2,
            py + pip.h / 2,
            pip.w * 0.7
          );
          sGrad.addColorStop(0, '#232936');
          sGrad.addColorStop(1, '#101319');
          ctx.fillStyle = sGrad;
          ctx.fillRect(px, py, pip.w, pip.h);

          ctx.fillStyle = '#384152';
          ctx.beginPath();
          ctx.arc(px + pip.w / 2, py + pip.h * 0.42, pip.h * 0.14, 0, Math.PI * 2);
          ctx.fill();

          ctx.beginPath();
          ctx.ellipse(
            px + pip.w / 2,
            py + pip.h * 0.86,
            pip.w * 0.28,
            pip.h * 0.24,
            0,
            Math.PI,
            0,
            false
          );
          ctx.fill();
        } else {
          ctx.fillStyle = '#12151c';
          ctx.fillRect(px, py, pip.w, pip.h);
          ctx.fillStyle = '#8b9098';
          ctx.font = '600 14px "JetBrains Mono", monospace';
          ctx.textAlign = 'center';
          ctx.fillText('CAM OFF', px + pip.w / 2, py + pip.h / 2 + 4);
        }

        ctx.fillStyle = 'rgba(0, 0, 0, 0.68)';
        ctx.fillRect(px, py, pip.w, 22);
        ctx.fillStyle = '#d1d5db';
        ctx.font = '700 12px "JetBrains Mono", monospace';
        ctx.textAlign = 'left';
        ctx.fillText(`YOU #${selfPin || '---'}`, px + 6, py + 15);

        if (!isMicOn) {
          ctx.fillStyle = '#f87171';
          ctx.font = '700 10px "JetBrains Mono", monospace';
          ctx.textAlign = 'right';
          ctx.fillText('MUTE', px + pip.w - 22, py + 15);
        }

        ctx.fillStyle = '#fca5a5';
        ctx.font = '700 14px "JetBrains Mono", monospace';
        ctx.textAlign = 'right';
        ctx.fillText('×', px + pip.w - 6, py + 16);

        ctx.strokeStyle = pip.dragging ? '#93c5fd' : 'rgba(255, 255, 255, 0.35)';
        ctx.lineWidth = pip.dragging ? 2.5 : 1.5;
        ctx.strokeRect(px - 1, py - 1, pip.w + 2, pip.h + 2);
      }

      // OSD header bar at top of 3D intercom screen with rotation indicator restored!
      const curDisp = livePropsRef.current.displayText;
      const isResetState = curDisp === 'RESET';
      ctx.fillStyle = 'rgba(6, 7, 9, 0.78)';
      ctx.fillRect(0, 0, w, 38);
      ctx.fillStyle = connected ? '#4ade80' : isResetState ? '#f87171' : '#d1d5db';
      ctx.font = '700 16px "JetBrains Mono", monospace';
      ctx.textAlign = 'left';
      ctx.fillText(
        connected ? `LIVE · #${pin || '---'}` : isResetState ? 'CAM 01 · RESET' : 'CAM 01 · READY',
        12,
        25
      );

      ctx.fillStyle = rotMode === 'auto' ? '#8ce99a' : '#fde047';
      ctx.font = '600 13px "JetBrains Mono", monospace';
      ctx.textAlign = 'right';
      ctx.fillText(`[ROT:${formatRotationLabel(rotMode)}]`, w - 114, 25);

      ctx.fillStyle = showSelf ? '#93c5fd' : '#9ca3af';
      ctx.font = '600 13px "JetBrains Mono", monospace';
      ctx.textAlign = 'right';
      ctx.fillText(showSelf ? '[SELF:ON]' : '[SELF:OFF]', w - 10, 25);

      videoScreenTex.needsUpdate = true;
      requestRender();
    }

    function setNightMode(night: boolean) {
      const targetBg = night ? 0x020305 : 0x0b0c0e;
      scene.background = new THREE.Color(targetBg);
      if (scene.fog instanceof THREE.FogExp2) {
        scene.fog.color.setHex(targetBg);
      }
      hemiLight.intensity = night ? 0.04 : 0.68;
      keyLight.intensity = night ? 0.06 : 1.55;
      rimLight.intensity = night ? 0.03 : 0.58;
      if ('environmentIntensity' in scene) {
        (scene as THREE.Scene & { environmentIntensity: number }).environmentIntensity = night
          ? 0.05
          : 1.0;
      }
      if (renderer) {
        renderer.toneMappingExposure = night ? 0.88 : 1.12;
      }
      sharedButtonMaterials.forEach((mat) => {
        if (mat instanceof THREE.MeshStandardMaterial) {
          mat.emissiveIntensity = night ? 0.85 : 0.30;
          mat.needsUpdate = true;
        }
      });
      requestRender();
    }

    function switchBrand(b: IntercomBrand) {
      currentBrandInternal = b;
      brandGroups.eltis.visible = b === 'eltis';
      brandGroups.vizit.visible = b === 'vizit';
      brandGroups.cyfral.visible = b === 'cyfral';
      requestRender();
    }

    // Smooth monotonic press-and-release for keyboard/2D dock triggers (zero oscillation!)
    function triggerButtonPress(label: string) {
      const normalized = label.toUpperCase();
      const st = buttonAnimMap.get(normalized);
      if (!st) return;
      // If user is currently holding this 3D button with pointer, don't override their hold
      if (heldButtonLabel === normalized) return;

      st.targetZ = BTN_PRESSED_Z;
      st.holdUntil = performance.now() + 75;
      requestRender();
    }

    sceneApiRef.current = {
      switchBrand,
      updateDisplay: drawDisplay,
      triggerButtonPress,
      refreshVideoScreen: drawVideoScreenNow,
      setNightMode,
    };

    switchBrand(brand);
    setNightMode(Boolean(livePropsRef.current.isNightMode));
    drawDisplay(displayText, brand);
    drawVideoScreenNow();

    const screenRefreshInterval = !isSoftwareGl
      ? window.setInterval(() => {
          if (unmounted) return;
          const locVid = localVideoElementRef?.current;
          const remVid = remoteVideoElementRef?.current;
          const hasLiveVideoStream =
            (livePropsRef.current.camEnabled && locVid && locVid.readyState >= 2) ||
            (livePropsRef.current.isCallConnected && remVid && remVid.readyState >= 2);
          if (hasLiveVideoStream) {
            drawVideoScreenNow();
          }
        }, 42)
      : window.setTimeout(() => {
          if (unmounted) return;
          drawVideoScreenNow();
        }, 350);

    const raycaster = new THREE.Raycaster();
    const pointer = new THREE.Vector2();
    let pointerDownPos = { x: 0, y: 0 };

    function getMonitorScreenHitUV(e: PointerEvent): { cx: number; cy: number } | null {
      const rect = domElem.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return null;
      scene.updateMatrixWorld();
      camera.updateMatrixWorld();
      pointer.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
      pointer.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
      raycaster.setFromCamera(pointer, camera);

      const screenMesh = monitorScreensByBrand[currentBrandInternal];
      if (!screenMesh) return null;
      const hits = raycaster.intersectObject(screenMesh, false);
      if (hits.length > 0 && hits[0].uv) {
        const uv = hits[0].uv;
        return {
          cx: uv.x * videoScreenCanvas.width,
          cy: (1 - uv.y) * videoScreenCanvas.height,
        };
      }
      return null;
    }

    const handlePointerDown = (e: PointerEvent) => {
      pointerDownPos = { x: e.clientX, y: e.clientY };

      const screenCoords = getMonitorScreenHitUV(e);
      if (screenCoords) {
        const { cx, cy } = screenCoords;
        if (cy <= 38 && cx >= videoScreenCanvas.width - 110) {
          controls.enabled = false;
          onToggleSelfPreviewRef.current?.();
          window.setTimeout(() => {
            controls.enabled = true;
          }, 80);
          return;
        }
        if (cy <= 38 && cx >= videoScreenCanvas.width - 238 && cx < videoScreenCanvas.width - 110) {
          controls.enabled = false;
          onRotateRemoteVideoRef.current?.();
          window.setTimeout(() => {
            controls.enabled = true;
          }, 80);
          return;
        }

        const pip = pipStateRef.current;
        if (
          livePropsRef.current.showSelfPreview &&
          cx >= pip.x &&
          cx <= pip.x + pip.w &&
          cy >= pip.y &&
          cy <= pip.y + pip.h
        ) {
          if (cx >= pip.x + pip.w - 28 && cy <= pip.y + 26) {
            controls.enabled = false;
            onToggleSelfPreviewRef.current?.();
            window.setTimeout(() => {
              controls.enabled = true;
            }, 80);
            return;
          }

          pip.dragging = true;
          pip.dragOffsetX = cx - pip.x;
          pip.dragOffsetY = cy - pip.y;
          controls.enabled = false;
          drawVideoScreenNow();
          return;
        }
      }

      // Check if user pressed directly on a 3D keypad button to smoothly depress it on pointerdown
      const rect = domElem.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) {
        scene.updateMatrixWorld();
        camera.updateMatrixWorld();
        pointer.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
        pointer.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
        raycaster.setFromCamera(pointer, camera);
        const activeButtons = buttonsByBrand[currentBrandInternal];
        const hits = raycaster.intersectObjects(activeButtons, false);
        if (hits.length > 0) {
          const label = hits[0].object.userData?.label;
          if (label) {
            heldButtonLabel = String(label).toUpperCase();
            const st = buttonAnimMap.get(heldButtonLabel);
            if (st) {
              st.targetZ = BTN_PRESSED_Z;
              st.holdUntil = Infinity;
              requestRender();
            }
          }
        }
      }
    };

    const handlePointerMove = (e: PointerEvent) => {
      const pip = pipStateRef.current;
      if (!pip.dragging) return;
      const screenCoords = getMonitorScreenHitUV(e);
      if (screenCoords) {
        const w = videoScreenCanvas.width;
        const h = videoScreenCanvas.height;
        pip.x = Math.max(8, Math.min(w - pip.w - 8, screenCoords.cx - pip.dragOffsetX));
        pip.y = Math.max(44, Math.min(h - pip.h - 8, screenCoords.cy - pip.dragOffsetY));
        drawVideoScreenNow();
      }
    };

    const releaseHeldButtonSmoothly = () => {
      if (!heldButtonLabel) return;
      const st = buttonAnimMap.get(heldButtonLabel);
      if (st) {
        // Ensure a brief minimum tactile depression if tapped very fast, then glide smoothly once to restZ
        if (st.currentZ > BTN_PRESSED_Z + 0.004) {
          st.targetZ = BTN_PRESSED_Z;
          st.holdUntil = performance.now() + 45;
        } else {
          st.holdUntil = 0;
          st.targetZ = BTN_REST_Z;
        }
        requestRender();
      }
      heldButtonLabel = null;
    };

    const handlePointerUp = (e: PointerEvent) => {
      const pip = pipStateRef.current;
      if (pip.dragging) {
        pip.dragging = false;
        controls.enabled = true;
        drawVideoScreenNow();
        return;
      }
      controls.enabled = true;

      const dx = Math.abs(e.clientX - pointerDownPos.x);
      const dy = Math.abs(e.clientY - pointerDownPos.y);
      if (dx > 8 || dy > 8) {
        releaseHeldButtonSmoothly();
        return;
      }

      const rect = domElem.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) {
        releaseHeldButtonSmoothly();
        return;
      }

      scene.updateMatrixWorld();
      camera.updateMatrixWorld();
      pointer.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
      pointer.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;

      raycaster.setFromCamera(pointer, camera);
      const activeButtons = buttonsByBrand[currentBrandInternal];
      const hits = raycaster.intersectObjects(activeButtons, false);

      if (hits.length > 0) {
        const hitMesh = hits[0].object;
        const label = hitMesh.userData?.label;
        if (label) {
          const normalized = String(label).toUpperCase();
          if (heldButtonLabel === normalized) {
            releaseHeldButtonSmoothly();
          } else {
            releaseHeldButtonSmoothly();
            triggerButtonPress(normalized);
          }
          onKeyPressRef.current(normalized);
          return;
        }
      }

      releaseHeldButtonSmoothly();
    };

    domElem.addEventListener('pointerdown', handlePointerDown);
    window.addEventListener('pointermove', handlePointerMove);
    window.addEventListener('pointerup', handlePointerUp);

    const handleResize = () => {
      if (!container || unmounted) return;
      const w = container.clientWidth || window.innerWidth;
      const h = container.clientHeight || window.innerHeight;
      if (renderer) {
        renderer.setSize(w, h);
      }
      if (softCanvas) {
        softCanvas.width = w;
        softCanvas.height = h;
      }
      fitCameraToViewport(w, h);
      requestRender();
    };

    window.addEventListener('resize', handleResize);

    return () => {
      unmounted = true;
      window.clearInterval(screenRefreshInterval);
      cancelAnimationFrame(frameId);
      clearTimeout(frameId);
      window.removeEventListener('resize', handleResize);
      domElem.removeEventListener('pointerdown', handlePointerDown);
      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('pointerup', handlePointerUp);
      controls.dispose();
      displayTex.dispose();
      videoScreenTex.dispose();
      cameraOpticsTex.dispose();
      armorSurface.dispose();
      eltisSurface.dispose();
      vizitSurface.dispose();
      cyfralSurface.dispose();
      darkInsertSurface.dispose();
      keycapSurface.dispose();
      speakerInternalSurface.dispose();
      concaveBtnGeo.dispose();
      speakerGrilleGeo.dispose();
      speakerGrilleMat.dispose();
      speakerBoreSleeveGeo.dispose();
      speakerBoreSleeveMat.dispose();
      speakerChamberGeo.dispose();
      speakerFoamMat.dispose();
      speakerMeshMat.dispose();
      disposableButtonTextures.forEach((t) => t.dispose());
      sharedButtonMaterials.forEach((m) => m.dispose());
      renderer?.dispose();
    };
  }, []);

  useEffect(() => {
    if (!sceneApiRef.current) return;
    sceneApiRef.current.switchBrand(brand);
    sceneApiRef.current.updateDisplay(displayText, brand);
    sceneApiRef.current.refreshVideoScreen();
  }, [brand]);

  useEffect(() => {
    if (!sceneApiRef.current) return;
    sceneApiRef.current.setNightMode(Boolean(isNightMode));
  }, [isNightMode]);

  useEffect(() => {
    if (!sceneApiRef.current) return;
    sceneApiRef.current.updateDisplay(displayText, brand);
  }, [displayText, brand]);

  useEffect(() => {
    if (!pressedKeyTrigger || !sceneApiRef.current) return;
    sceneApiRef.current.triggerButtonPress(pressedKeyTrigger.key);
  }, [pressedKeyTrigger]);

  useEffect(() => {
    if (!sceneApiRef.current) return;
    sceneApiRef.current.refreshVideoScreen();
  }, [
    displayText,
    remoteFrameSeq,
    isCallConnected,
    peerPin,
    myPin,
    camEnabled,
    micEnabled,
    peerMicEnabled,
    peerCamEnabled,
    mirrorLocalVideo,
    showSelfPreview,
    remoteRotation,
    baselinePeerIsPortrait,
    brand,
    isNightMode,
  ]);

  return (
    <div
      ref={mountRef}
      data-testid="intercom-3d-canvas"
      data-led-display={displayText}
      data-brand={brand}
      data-night-mode={isNightMode ? 'true' : 'false'}
      className="w-full h-full relative select-none cursor-grab active:cursor-grabbing"
      aria-label="3D панель домофона"
    />
  );
};

