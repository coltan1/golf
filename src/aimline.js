/**
 * aimline.js — the soft ribbon showing where you're aimed.
 *
 * It's a real strip of geometry that samples the terrain height, so it lies on
 * the ground over rolls and hollows instead of slicing through them.
 */

import * as THREE from 'three';
import { heightAt } from './course.js';
import { clamp } from './util.js';

const SEG = 26;
const LENGTH = 24;
const WIDTH = 1.6;

function makeRibbonTexture() {
  const W = 512, H = 128;
  const cv = document.createElement('canvas');
  cv.width = W; cv.height = H;
  const ctx = cv.getContext('2d');
  const img = ctx.createImageData(W, H);
  // Discrete chevrons with clear gaps between them. A continuous ribbon just
  // reads as haze against light grass; separate marks stay legible and calm.
  const COUNT = 7;
  for (let y = 0; y < H; y++) {
    const v = Math.abs((y / (H - 1)) * 2 - 1);       // 0 at the centreline
    const across = Math.pow(1 - v, 0.5);
    for (let x = 0; x < W; x++) {
      const u = x / (W - 1);
      // Chevron: each mark is swept back at the edges, so it points forward.
      const local = (u * COUNT + v * 0.34) % 1;
      const mark = (1 - clamp(Math.abs(local - 0.35) / 0.3, 0, 1));
      const shape = Math.pow(mark, 0.7);
      // Fade in just off the ball, taper out toward the target.
      const along = Math.min(1, u / 0.1) * Math.pow(1 - u, 1.35);
      const a = clamp(shape * across * along, 0, 1);
      const o = (y * W + x) * 4;
      img.data[o] = 255; img.data[o + 1] = 255; img.data[o + 2] = 250;
      img.data[o + 3] = Math.round(a * 255);
    }
  }
  ctx.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

export class AimLine {
  constructor(scene) {
    const verts = (SEG + 1) * 2;
    this.positions = new Float32Array(verts * 3);
    const uvs = new Float32Array(verts * 2);
    const idx = new Uint16Array(SEG * 6);

    for (let i = 0; i <= SEG; i++) {
      const u = i / SEG;
      uvs[(i * 2) * 2] = u;     uvs[(i * 2) * 2 + 1] = 0;
      uvs[(i * 2 + 1) * 2] = u; uvs[(i * 2 + 1) * 2 + 1] = 1;
    }
    for (let i = 0, t = 0; i < SEG; i++) {
      const a = i * 2, b = a + 1, c = a + 2, d = a + 3;
      idx[t++] = a; idx[t++] = c; idx[t++] = b;
      idx[t++] = b; idx[t++] = c; idx[t++] = d;
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(this.positions, 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
    geo.setIndex(new THREE.BufferAttribute(idx, 1));
    this.geo = geo;

    this.mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({
      map: makeRibbonTexture(),
      transparent: true,
      depthWrite: false,
      opacity: 0,
      side: THREE.DoubleSide,
      fog: false,
    }));
    this.mesh.renderOrder = 3;
    this.mesh.frustumCulled = false;
    scene.add(this.mesh);
    this.opacity = 0;
  }

  /** Re-lay the ribbon from the ball along `aim`. Cheap — 27 height samples. */
  layout(x, z, aim) {
    const dx = Math.sin(aim), dz = -Math.cos(aim);
    const px = Math.cos(aim), pz = Math.sin(aim); // right-hand perpendicular
    for (let i = 0; i <= SEG; i++) {
      const d = 1.2 + (i / SEG) * LENGTH;
      const cx = x + dx * d, cz = z + dz * d;
      const y = heightAt(cx, cz) + 0.10;
      const w = WIDTH * (1 + (i / SEG) * 0.35);
      const o = i * 6;
      this.positions[o] = cx - px * w;     this.positions[o + 1] = y; this.positions[o + 2] = cz - pz * w;
      this.positions[o + 3] = cx + px * w; this.positions[o + 4] = y; this.positions[o + 5] = cz + pz * w;
    }
    this.geo.attributes.position.needsUpdate = true;
  }

  setVisible(on) { this.target = on ? 0.92 : 0; }

  update(dt) {
    const t = this.target ?? 0;
    this.opacity += (t - this.opacity) * Math.min(1, dt * 7);
    this.mesh.material.opacity = this.opacity;
    this.mesh.visible = this.opacity > 0.01;
  }
}
