# Splat Fluid

**3D Gaussian Splats dissolve into real-time fluid simulation.**

Load any `.splat` file, preview it with a proper 3D Gaussian Splatting renderer, then hit Start and watch the gaussians become fluid particles governed by a GPU-based FLIP solver. Each particle keeps its original color and gaussian shape as it flows, splashes, and settles.

## How It Works

1. **Load** a `.splat` file — positions, rotations, scales, and colors are parsed and packed into GPU textures
2. **Preview** the splat with full 3D Gaussian Splatting: covariance matrices are projected to screen space via the Jacobian of perspective projection, rendered as instanced quads with proper gaussian evaluation in the fragment shader
3. **Simulate** — press Start and only the in-bounds gaussians become FLIP fluid particles. The GPU solver handles velocity transfer, pressure projection, and advection while the renderer draws each particle as its original gaussian

## Controls

- **Drag** to orbit the camera
- **Scroll** to zoom
- **Splat Scale** — resize the splat within the fluid container (up to 50x)
- **Position X/Y/Z** — shift the splat inside the container before starting
- **Point Size** — scale the visual size of each gaussian
- **Start** — begin fluid simulation
- **Fluidity** — PIC/FLIP blend (higher = more fluid, less viscous)
- **Speed** — simulation timestep
- **Move mouse** — push particles around during simulation

## Running Locally

```bash
# Clone the repo
git clone https://github.com/glaseagle/splat-fluid.git
cd splat-fluid

# Drop a .splat file in the root directory
# (default expects rainbow-cars.splat — edit splatfluid.js line 163 to change)

# Serve it
python -m http.server 8080

# Open http://localhost:8080/splat-fluid.html
```

> `.splat` files are not included in the repo due to size. You can export them from [SuperSplat](https://playcanvas.com/supersplat/editor), [Luma AI](https://lumalabs.ai/), or convert from `.ply` using standard 3DGS tools.

## Tech

- **Rendering**: Instanced quad 3D Gaussian Splatting in WebGL 1 (ANGLE_instanced_arrays)
- **Simulation**: GPU FLIP/PIC fluid solver ([dli/fluid](https://github.com/dli/fluid))
- **Format**: Standard `.splat` binary (32 bytes/vertex: 3xF32 pos, 3xF32 scale, 4xU8 RGBA, 4xU8 quaternion)

Built on top of [David Li's fluid simulation](https://github.com/dli/fluid).
