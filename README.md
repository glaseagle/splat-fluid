# Splat Fluid

**3D Gaussian Splats meet real-time fluid simulation.**

https://github.com/user-attachments/assets/placeholder

Load a Gaussian Splat, position and scale it inside a fluid container, then hit **Start** and watch it dissolve into a real-time FLIP fluid simulation. Every particle keeps its original color and gaussian shape as it flows, splashes, and pools.

## How It Works

A `.splat` file is parsed into positions, colors, rotations, and scales. The 3D covariance matrix for each gaussian is computed from its quaternion rotation and anisotropic scale, then packed into GPU textures. In preview mode, instanced quads render each gaussian with proper screen-space covariance projection. When you press Start, the visible gaussians become particles in a GPU FLIP/PIC fluid solver — the simulation runs entirely on the GPU while the renderer draws each particle as its original colored gaussian.

## Controls

| Control | What it does |
|---|---|
| **Drag** | Orbit camera |
| **Scroll** | Zoom |
| **Splat Scale** | Resize the splat (up to 50x) |
| **Position X/Y/Z** | Shift the splat inside the container |
| **Zoom** | Camera orbit distance |
| **Point Size** | Visual size of each gaussian |
| **Start** | Begin fluid simulation |
| **Particle Radius** | Fluid collision radius (smaller = less viscous) |
| **Fluidity** | PIC/FLIP blend ratio |
| **Speed** | Simulation timestep |
| **Mouse movement** | Push particles during simulation |

## Running Locally

```bash
git clone https://github.com/glaseagle/splat-fluid.git
cd splat-fluid
python -m http.server 8080
# Open http://localhost:8080/splat-fluid.html
```

The Rainbow Cars splat is included in the repo. To use a different splat, drop a `.splat` file in the root directory and update the fetch URL in `splatfluid.js`.

## Using Your Own Splats

The loader expects the standard `.splat` binary format (32 bytes per vertex):

| Bytes | Type | Content |
|---|---|---|
| 0–11 | 3x float32 | Position (x, y, z) |
| 12–23 | 3x float32 | Scale (sx, sy, sz) |
| 24–27 | 4x uint8 | Color (r, g, b, a) |
| 28–31 | 4x uint8 | Rotation quaternion (w, x, y, z) |

Export from [SuperSplat](https://playcanvas.com/supersplat/editor), [Luma AI](https://lumalabs.ai/), [Polycam](https://poly.cam/), or convert from `.ply` with standard 3DGS tools.

## Tech Stack

- **Rendering** — Instanced quad 3D Gaussian Splatting in WebGL 1 (ANGLE_instanced_arrays, covariance projection via Jacobian)
- **Simulation** — GPU FLIP/PIC fluid solver ([dli/fluid](https://github.com/dli/fluid))
- **No dependencies** — Pure WebGL, no libraries

Built on top of [David Li's fluid simulation](https://github.com/dli/fluid).
