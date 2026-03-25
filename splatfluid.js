'use strict'

var SplatFluid = (function () {
    var FOV = Math.PI / 3;
    var PARTICLES_PER_CELL = 10;
    var MAX_PARTICLES = 60000;
    var TARGET_SIZE = 30;
    var PADDING = 2;

    var State = { LOADING: 0, PREVIEW: 1, SIMULATING: 2 };

    // ---- Proper 3D Gaussian Splatting shaders ----

    var GSPLAT_VERT = [
        'precision highp float;',
        '',
        'attribute vec2 a_quadVertex;',
        'attribute vec2 a_textureCoordinates;',
        '',
        'uniform mat4 u_projectionMatrix;',
        'uniform mat4 u_viewMatrix;',
        'uniform sampler2D u_positionsTexture;',
        'uniform sampler2D u_covATexture;',
        'uniform sampler2D u_covBTexture;',
        'uniform sampler2D u_colorsTexture;',
        'uniform vec2 u_viewport;',
        'uniform vec3 u_gridMin;',
        'uniform vec3 u_gridMax;',
        'uniform vec3 u_gridCenter;',
        'uniform float u_applyScale;',
        'uniform float u_splatScale;',
        'uniform float u_covScale;',
        'uniform vec3 u_positionOffset;',
        '',
        'varying vec3 v_color;',
        'varying float v_opacity;',
        'varying vec2 v_offset;',
        'varying vec3 v_conic;',
        '',
        'void main() {',
        '    vec3 rawPos = texture2D(u_positionsTexture, a_textureCoordinates).rgb;',
        '    vec3 pos = mix(rawPos, u_gridCenter + (rawPos - u_gridCenter) * u_splatScale, u_applyScale) + u_positionOffset;',
        '',
        '    if (pos.x < u_gridMin.x || pos.x > u_gridMax.x ||',
        '        pos.y < u_gridMin.y || pos.y > u_gridMax.y ||',
        '        pos.z < u_gridMin.z || pos.z > u_gridMax.z) {',
        '        gl_Position = vec4(0.0, 0.0, -2.0, 1.0);',
        '        return;',
        '    }',
        '',
        '    vec4 viewPos = u_viewMatrix * vec4(pos, 1.0);',
        '    if (viewPos.z > -0.1) { gl_Position = vec4(0.0, 0.0, -2.0, 1.0); return; }',
        '',
        '    vec4 cA = texture2D(u_covATexture, a_textureCoordinates) * u_covScale;',
        '    vec4 cBraw = texture2D(u_covBTexture, a_textureCoordinates);',
        '    float c00 = cA.x, c01 = cA.y, c02 = cA.z, c11 = cA.w;',
        '    float c12 = cBraw.x * u_covScale, c22 = cBraw.y * u_covScale;',
        '    v_opacity = cBraw.z;',
        '    v_color = texture2D(u_colorsTexture, a_textureCoordinates).rgb;',
        '',
        '    mat3 V = mat3(u_viewMatrix);',
        '    vec3 vr0 = vec3(V[0].x, V[1].x, V[2].x);',
        '    vec3 vr1 = vec3(V[0].y, V[1].y, V[2].y);',
        '    vec3 vr2 = vec3(V[0].z, V[1].z, V[2].z);',
        '',
        '    float fx = u_projectionMatrix[0][0] * u_viewport.x * 0.5;',
        '    float fy = u_projectionMatrix[1][1] * u_viewport.y * 0.5;',
        '    float tz = viewPos.z;',
        '    float itz = 1.0 / tz;',
        '    float itz2 = itz * itz;',
        '',
        '    vec3 j0 = fx * itz * vr0 + (-fx * viewPos.x * itz2) * vr2;',
        '    vec3 j1 = fy * itz * vr1 + (-fy * viewPos.y * itz2) * vr2;',
        '',
        '    vec3 sj0 = vec3(c00*j0.x + c01*j0.y + c02*j0.z,',
        '                    c01*j0.x + c11*j0.y + c12*j0.z,',
        '                    c02*j0.x + c12*j0.y + c22*j0.z);',
        '    vec3 sj1 = vec3(c00*j1.x + c01*j1.y + c02*j1.z,',
        '                    c01*j1.x + c11*j1.y + c12*j1.z,',
        '                    c02*j1.x + c12*j1.y + c22*j1.z);',
        '',
        '    float s00 = dot(j0, sj0) + 0.3;',
        '    float s01 = dot(j0, sj1);',
        '    float s11 = dot(j1, sj1) + 0.3;',
        '',
        '    float det = s00 * s11 - s01 * s01;',
        '    if (det < 1e-6) { gl_Position = vec4(0.0, 0.0, -2.0, 1.0); return; }',
        '    float inv_det = 1.0 / det;',
        '    v_conic = vec3(s11 * inv_det, -s01 * inv_det, s00 * inv_det);',
        '',
        '    float mid = 0.5 * (s00 + s11);',
        '    float radius = ceil(3.0 * sqrt(max(mid + sqrt(max(mid * mid - det, 0.0)), 0.1)));',
        '',
        '    vec4 clipPos = u_projectionMatrix * viewPos;',
        '    vec2 screenCenter = (clipPos.xy / clipPos.w * 0.5 + 0.5) * u_viewport;',
        '    v_offset = a_quadVertex * radius;',
        '    vec2 screenPos = screenCenter + v_offset;',
        '    vec2 ndc = screenPos / u_viewport * 2.0 - 1.0;',
        '    gl_Position = vec4(ndc * clipPos.w, clipPos.z, clipPos.w);',
        '}'
    ].join('\n');

    var GSPLAT_FRAG = [
        'precision highp float;',
        '',
        'varying vec3 v_color;',
        'varying float v_opacity;',
        'varying vec2 v_offset;',
        'varying vec3 v_conic;',
        '',
        'void main() {',
        '    float power = -0.5 * (v_conic.x * v_offset.x * v_offset.x +',
        '                          2.0 * v_conic.y * v_offset.x * v_offset.y +',
        '                          v_conic.z * v_offset.y * v_offset.y);',
        '    if (power > 0.0) discard;',
        '    float alpha = min(0.99, v_opacity * exp(power));',
        '    if (alpha < 0.004) discard;',
        '    gl_FragColor = vec4(v_color * alpha, alpha);',
        '}'
    ].join('\n');

    function SplatFluid () {
        var canvas = this.canvas = document.getElementById('canvas');
        var wgl = this.wgl = new WrappedGL(canvas);
        window.wgl = wgl;

        this.state = State.LOADING;
        this.projectionMatrix = Utilities.makePerspectiveMatrix(new Float32Array(16), FOV, canvas.width / canvas.height, 0.1, 200.0);

        this.camera = null;
        this.simulator = null;
        this.timeStep = 1.0 / 60.0;

        this.splatCount = 0;
        this.gridWidth = 0;
        this.gridHeight = 0;
        this.gridDepth = 0;
        this.particlesWidth = 0;
        this.particlesHeight = 0;

        this.splatScale = 1.0;
        this.pointSizeScale = 1.0;
        this.lockedCovScale = 1.0;
        this.positionOffset = [0, 0, 0];

        // Mouse tracking
        this.mouseX = 0;
        this.mouseY = 0;
        this.lastMousePlaneX = 0;
        this.lastMousePlaneY = 0;

        wgl.getExtension('OES_texture_float');
        wgl.getExtension('OES_texture_float_linear');
        wgl.getExtension('OES_texture_half_float');
        wgl.getExtension('OES_texture_half_float_linear');
        wgl.getExtension('ANGLE_instanced_arrays');

        this.loadSplat();
    }

    SplatFluid.prototype.loadSplat = function () {
        var self = this;
        var loadingEl = document.getElementById('loading');

        fetch('rainbow-cars.splat').then(function (r) {
            loadingEl.textContent = 'Parsing splat data...';
            return r.arrayBuffer();
        }).then(function (buffer) {
            self.parseSplat(buffer);
            loadingEl.textContent = 'Initializing...';
            self.initScene();
        }).catch(function (err) {
            loadingEl.textContent = 'Error: ' + err.message;
        });
    };

    SplatFluid.prototype.parseSplat = function (buffer) {
        var vertexCount = buffer.byteLength / 32;
        var f32 = new Float32Array(buffer);
        var u8 = new Uint8Array(buffer);

        var stride = Math.max(1, Math.floor(vertexCount / MAX_PARTICLES));
        var count = Math.min(MAX_PARTICLES, Math.floor(vertexCount / stride));

        // Bounds
        var minX = Infinity, maxX = -Infinity;
        var minY = Infinity, maxY = -Infinity;
        var minZ = Infinity, maxZ = -Infinity;
        for (var i = 0; i < count; i++) {
            var fBase = i * stride * 8;
            var x = f32[fBase], y = f32[fBase + 1], z = f32[fBase + 2];
            if (x < minX) minX = x; if (x > maxX) maxX = x;
            if (y < minY) minY = y; if (y > maxY) maxY = y;
            if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
        }

        var rangeX = maxX - minX, rangeY = maxY - minY, rangeZ = maxZ - minZ;
        var maxRange = Math.max(rangeX, rangeY, rangeZ);
        var bsf = TARGET_SIZE / maxRange; // base scale factor

        this.gridWidth  = Math.ceil(rangeX * bsf) + PADDING * 2;
        this.gridHeight = Math.ceil(rangeY * bsf) + PADDING * 2;
        this.gridDepth  = Math.ceil(rangeZ * bsf) + PADDING * 2;

        this.particlesWidth = 512;
        this.particlesHeight = Math.ceil(count / this.particlesWidth);
        var totalSlots = this.particlesWidth * this.particlesHeight;

        var positions = new Float32Array(totalSlots * 4);
        var covAData  = new Float32Array(totalSlots * 4);
        var covBData  = new Float32Array(totalSlots * 4);
        var colors    = new Float32Array(totalSlots * 4);

        for (var i = 0; i < count; i++) {
            var srcIdx = i * stride;
            var fBase = srcIdx * 8;
            var byteBase = srcIdx * 32;

            // Position in grid space (base scale)
            positions[i*4]   = (f32[fBase]     - minX) * bsf + PADDING;
            positions[i*4+1] = (f32[fBase + 1] - minY) * bsf + PADDING;
            positions[i*4+2] = (f32[fBase + 2] - minZ) * bsf + PADDING;

            // Scale in grid units
            var sx = f32[fBase + 3] * bsf;
            var sy = f32[fBase + 4] * bsf;
            var sz = f32[fBase + 5] * bsf;

            // Quaternion from uint8
            var qw = (u8[byteBase + 28] - 128) / 128;
            var qx = (u8[byteBase + 29] - 128) / 128;
            var qy = (u8[byteBase + 30] - 128) / 128;
            var qz = (u8[byteBase + 31] - 128) / 128;
            var qlen = Math.sqrt(qw*qw + qx*qx + qy*qy + qz*qz) || 1;
            qw /= qlen; qx /= qlen; qy /= qlen; qz /= qlen;

            // Rotation matrix
            var R00 = 1-2*(qy*qy+qz*qz), R01 = 2*(qx*qy-qw*qz), R02 = 2*(qx*qz+qw*qy);
            var R10 = 2*(qx*qy+qw*qz), R11 = 1-2*(qx*qx+qz*qz), R12 = 2*(qy*qz-qw*qx);
            var R20 = 2*(qx*qz-qw*qy), R21 = 2*(qy*qz+qw*qx), R22 = 1-2*(qx*qx+qy*qy);

            // M = R * diag(sx,sy,sz)
            var M00=R00*sx, M01=R01*sy, M02=R02*sz;
            var M10=R10*sx, M11=R11*sy, M12=R12*sz;
            var M20=R20*sx, M21=R21*sy, M22=R22*sz;

            // Σ = M * M^T (upper triangle)
            covAData[i*4]   = M00*M00 + M01*M01 + M02*M02; // c00
            covAData[i*4+1] = M00*M10 + M01*M11 + M02*M12; // c01
            covAData[i*4+2] = M00*M20 + M01*M21 + M02*M22; // c02
            covAData[i*4+3] = M10*M10 + M11*M11 + M12*M12; // c11
            covBData[i*4]   = M10*M20 + M11*M21 + M12*M22; // c12
            covBData[i*4+1] = M20*M20 + M21*M21 + M22*M22; // c22
            covBData[i*4+2] = u8[byteBase + 27] / 255;      // opacity

            // Color
            colors[i*4]   = u8[byteBase + 24] / 255;
            colors[i*4+1] = u8[byteBase + 25] / 255;
            colors[i*4+2] = u8[byteBase + 26] / 255;
            colors[i*4+3] = 1.0;
        }

        // Pad remaining slots (zero opacity hides them)
        for (var i = count; i < totalSlots; i++) {
            positions[i*4]   = positions[(count-1)*4];
            positions[i*4+1] = positions[(count-1)*4+1];
            positions[i*4+2] = positions[(count-1)*4+2];
            covBData[i*4+2]  = 0;
        }

        this.splatCount = count;
        this.positionData = positions;
        this.covAData = covAData;
        this.covBData = covBData;
        this.colorData = colors;
    };

    SplatFluid.prototype.initScene = function () {
        var wgl = this.wgl;
        var self = this;

        // Camera
        this.camera = new Camera(this.canvas, [this.gridWidth/2, this.gridHeight/2, this.gridDepth/2]);
        this.camera.distance = Math.max(this.gridWidth, this.gridHeight, this.gridDepth) * 1.5;
        this.camera.setBounds(-Math.PI / 3, Math.PI / 3);

        // Splat program
        this.splatProgram = wgl.createProgram(GSPLAT_VERT, GSPLAT_FRAG, {
            'a_quadVertex': 0,
            'a_textureCoordinates': 1
        });

        // Quad vertex buffer (4 verts for TRIANGLE_STRIP)
        this.quadVertexBuffer = wgl.createBuffer();
        wgl.bufferData(this.quadVertexBuffer, wgl.ARRAY_BUFFER,
            new Float32Array([-1,-1, 1,-1, -1,1, 1,1]), wgl.STATIC_DRAW);

        // Per-instance texture coordinate buffer
        this.texCoordBuffer = wgl.createBuffer();
        var texCoords = new Float32Array(this.particlesWidth * this.particlesHeight * 2);
        for (var y = 0; y < this.particlesHeight; y++) {
            for (var x = 0; x < this.particlesWidth; x++) {
                var idx = (y * this.particlesWidth + x) * 2;
                texCoords[idx]   = (x + 0.5) / this.particlesWidth;
                texCoords[idx+1] = (y + 0.5) / this.particlesHeight;
            }
        }
        wgl.bufferData(this.texCoordBuffer, wgl.ARRAY_BUFFER, texCoords, wgl.STATIC_DRAW);

        // Textures
        this.positionTexture = wgl.createTexture();
        wgl.rebuildTexture(this.positionTexture, wgl.RGBA, wgl.FLOAT,
            this.particlesWidth, this.particlesHeight, this.positionData,
            wgl.CLAMP_TO_EDGE, wgl.CLAMP_TO_EDGE, wgl.NEAREST, wgl.NEAREST);

        this.covATexture = wgl.createTexture();
        wgl.rebuildTexture(this.covATexture, wgl.RGBA, wgl.FLOAT,
            this.particlesWidth, this.particlesHeight, this.covAData,
            wgl.CLAMP_TO_EDGE, wgl.CLAMP_TO_EDGE, wgl.NEAREST, wgl.NEAREST);

        this.covBTexture = wgl.createTexture();
        wgl.rebuildTexture(this.covBTexture, wgl.RGBA, wgl.FLOAT,
            this.particlesWidth, this.particlesHeight, this.covBData,
            wgl.CLAMP_TO_EDGE, wgl.CLAMP_TO_EDGE, wgl.NEAREST, wgl.NEAREST);

        this.colorTexture = wgl.createTexture();
        wgl.rebuildTexture(this.colorTexture, wgl.RGBA, wgl.FLOAT,
            this.particlesWidth, this.particlesHeight, this.colorData,
            wgl.CLAMP_TO_EDGE, wgl.CLAMP_TO_EDGE, wgl.NEAREST, wgl.NEAREST);

        // Simulator
        this.simulator = new Simulator(wgl, function () {
            self.onReady();
        });
    };

    SplatFluid.prototype.onReady = function () {
        this.state = State.PREVIEW;
        document.getElementById('loading').style.display = 'none';
        document.getElementById('ui').style.display = 'block';
        document.getElementById('particle-info').textContent = this.splatCount + ' gaussians';

        var self = this;

        this.startButton = document.getElementById('start-button');
        this.startButton.addEventListener('click', function () {
            if (self.state === State.PREVIEW) self.startSimulation();
            else if (self.state === State.SIMULATING) self.stopSimulation();
        });

        this.flipnessSlider = new Slider(document.getElementById('fluidity-slider'),
            this.simulator.flipness, 0.5, 0.99, function (v) { self.simulator.flipness = v; });

        this.speedSlider = new Slider(document.getElementById('speed-slider'),
            this.timeStep, 0.0, 1.0/60.0, function (v) { self.timeStep = v; });

        this.scaleSlider = new Slider(document.getElementById('scale-slider'),
            this.splatScale, 0.1, 50.0, function (v) { self.splatScale = v; });

        this.pointSizeSlider = new Slider(document.getElementById('pointsize-slider'),
            this.pointSizeScale, 0.1, 5.0, function (v) { self.pointSizeScale = v; });

        var moveButtons = document.querySelectorAll('.move-btn');
        for (var i = 0; i < moveButtons.length; i++) {
            moveButtons[i].addEventListener('click', (function (btn) {
                return function () {
                    var axis = btn.getAttribute('data-axis');
                    var dir = parseFloat(btn.getAttribute('data-dir'));
                    var idx = axis === 'x' ? 0 : axis === 'y' ? 1 : 2;
                    self.positionOffset[idx] += dir * 1.0;
                };
            })(moveButtons[i]));
        }

        this.canvas.addEventListener('mousemove', this.onMouseMove.bind(this));
        this.canvas.addEventListener('mousedown', this.onMouseDown.bind(this));
        document.addEventListener('mouseup', this.onMouseUp.bind(this));
        window.addEventListener('resize', this.onResize.bind(this));
        this.onResize();

        var lastTime = 0;
        var update = (function (currentTime) {
            var deltaTime = currentTime - lastTime || 0;
            lastTime = currentTime;
            this.update(deltaTime);
            requestAnimationFrame(update);
        }).bind(this);
        update();
    };

    SplatFluid.prototype.onResize = function () {
        this.canvas.width = window.innerWidth;
        this.canvas.height = window.innerHeight;
        Utilities.makePerspectiveMatrix(this.projectionMatrix, FOV, this.canvas.width / this.canvas.height, 0.1, 200.0);
    };

    SplatFluid.prototype.onMouseMove = function (event) {
        event.preventDefault();
        var pos = Utilities.getMousePosition(event, this.canvas);
        this.mouseX = (pos.x / this.canvas.width) * 2.0 - 1.0;
        this.mouseY = (1.0 - pos.y / this.canvas.height) * 2.0 - 1.0;
        this.camera.onMouseMove(event);
    };

    SplatFluid.prototype.onMouseDown = function (event) {
        event.preventDefault();
        this.camera.onMouseDown(event);
    };

    SplatFluid.prototype.onMouseUp = function (event) {
        event.preventDefault();
        this.camera.onMouseUp(event);
    };

    SplatFluid.prototype.startSimulation = function () {
        this.state = State.SIMULATING;

        var cx = this.gridWidth / 2, cy = this.gridHeight / 2, cz = this.gridDepth / 2;
        var s = this.splatScale;
        var margin = 0.5;
        var wgl = this.wgl;

        // Filter to only in-bounds particles
        var inBounds = [];
        for (var i = 0; i < this.splatCount; i++) {
            var bx = this.positionData[i*4], by = this.positionData[i*4+1], bz = this.positionData[i*4+2];
            var px = cx + (bx - cx) * s + this.positionOffset[0];
            var py = cy + (by - cy) * s + this.positionOffset[1];
            var pz = cz + (bz - cz) * s + this.positionOffset[2];
            if (px > margin && px < this.gridWidth - margin &&
                py > margin && py < this.gridHeight - margin &&
                pz > margin && pz < this.gridDepth - margin) {
                inBounds.push({ idx: i, x: px, y: py, z: pz });
            }
        }

        var simCount = inBounds.length;
        if (simCount === 0) { this.state = State.PREVIEW; return; }

        var simWidth = 512;
        var simHeight = Math.ceil(simCount / simWidth);
        var simSlots = simWidth * simHeight;

        // Build position array and rebuild covariance/color textures for sim particles only
        var simPositions = [];
        var simCovA = new Float32Array(simSlots * 4);
        var simCovB = new Float32Array(simSlots * 4);
        var simColors = new Float32Array(simSlots * 4);

        for (var i = 0; i < simCount; i++) {
            var src = inBounds[i];
            simPositions.push([src.x, src.y, src.z]);
            var si = src.idx;
            simCovA[i*4]   = this.covAData[si*4];
            simCovA[i*4+1] = this.covAData[si*4+1];
            simCovA[i*4+2] = this.covAData[si*4+2];
            simCovA[i*4+3] = this.covAData[si*4+3];
            simCovB[i*4]   = this.covBData[si*4];
            simCovB[i*4+1] = this.covBData[si*4+1];
            simCovB[i*4+2] = this.covBData[si*4+2];
            simCovB[i*4+3] = this.covBData[si*4+3];
            simColors[i*4]   = this.colorData[si*4];
            simColors[i*4+1] = this.colorData[si*4+1];
            simColors[i*4+2] = this.colorData[si*4+2];
            simColors[i*4+3] = this.colorData[si*4+3];
        }
        // Pad remaining slots with last valid position and zero opacity
        for (var i = simCount; i < simSlots; i++) {
            simPositions.push([inBounds[simCount-1].x, inBounds[simCount-1].y, inBounds[simCount-1].z]);
            simCovB[i*4+2] = 0; // zero opacity
        }

        // Store sim textures for rendering
        this.simCovATexture = wgl.createTexture();
        wgl.rebuildTexture(this.simCovATexture, wgl.RGBA, wgl.FLOAT,
            simWidth, simHeight, simCovA,
            wgl.CLAMP_TO_EDGE, wgl.CLAMP_TO_EDGE, wgl.NEAREST, wgl.NEAREST);
        this.simCovBTexture = wgl.createTexture();
        wgl.rebuildTexture(this.simCovBTexture, wgl.RGBA, wgl.FLOAT,
            simWidth, simHeight, simCovB,
            wgl.CLAMP_TO_EDGE, wgl.CLAMP_TO_EDGE, wgl.NEAREST, wgl.NEAREST);
        this.simColorTexture = wgl.createTexture();
        wgl.rebuildTexture(this.simColorTexture, wgl.RGBA, wgl.FLOAT,
            simWidth, simHeight, simColors,
            wgl.CLAMP_TO_EDGE, wgl.CLAMP_TO_EDGE, wgl.NEAREST, wgl.NEAREST);

        // Rebuild tex coord buffer for sim particle count
        this.simTexCoordBuffer = wgl.createBuffer();
        var simTexCoords = new Float32Array(simSlots * 2);
        for (var y = 0; y < simHeight; y++) {
            for (var x = 0; x < simWidth; x++) {
                var idx = (y * simWidth + x) * 2;
                simTexCoords[idx]   = (x + 0.5) / simWidth;
                simTexCoords[idx+1] = (y + 0.5) / simHeight;
            }
        }
        wgl.bufferData(this.simTexCoordBuffer, wgl.ARRAY_BUFFER, simTexCoords, wgl.STATIC_DRAW);

        this.simParticleCount = simCount;
        this.simParticlesWidth = simWidth;
        this.simParticlesHeight = simHeight;

        // Lock the covariance scale for simulation
        this.lockedCovScale = s * s * this.pointSizeScale * this.pointSizeScale;

        // Grid resolution
        var totalCells = this.gridWidth * this.gridHeight * this.gridDepth * 0.5;
        var ratioX = this.gridWidth / this.gridHeight;
        var ratioZ = this.gridDepth / this.gridHeight;
        var gry = Math.ceil(Math.pow(totalCells / (ratioX * ratioZ), 1.0/3.0));
        var grx = Math.ceil(gry * ratioX);
        var grz = Math.ceil(gry * ratioZ);

        this.simulator.reset(
            simWidth, simHeight,
            simPositions,
            [this.gridWidth, this.gridHeight, this.gridDepth],
            [grx, gry, grz],
            PARTICLES_PER_CELL
        );

        this.camera.setBounds(0, Math.PI / 2);
        this.startButton.textContent = 'Edit';
        document.getElementById('instructions-preview').style.display = 'none';
        document.getElementById('instructions-sim').style.display = 'block';
        document.getElementById('scale-row').style.display = 'none';
        document.getElementById('move-controls').style.display = 'none';
        this.positionOffset = [0, 0, 0];
        var simUIs = document.querySelectorAll('.simulating-ui');
        for (var i = 0; i < simUIs.length; i++) simUIs[i].style.display = 'block';
        this.flipnessSlider.redraw();
        this.speedSlider.redraw();
    };

    SplatFluid.prototype.stopSimulation = function () {
        this.state = State.PREVIEW;
        this.camera.setBounds(-Math.PI / 3, Math.PI / 3);
        this.startButton.textContent = 'Start';
        document.getElementById('instructions-preview').style.display = 'block';
        document.getElementById('instructions-sim').style.display = 'none';
        document.getElementById('scale-row').style.display = 'block';
        document.getElementById('move-controls').style.display = 'block';
        var simUIs = document.querySelectorAll('.simulating-ui');
        for (var i = 0; i < simUIs.length; i++) simUIs[i].style.display = 'none';
    };

    SplatFluid.prototype.getMouseInteraction = function () {
        var fov = 2.0 * Math.atan(1.0 / this.projectionMatrix[5]);
        var vr = [
            this.mouseX * Math.tan(fov/2.0) * (this.canvas.width / this.canvas.height),
            this.mouseY * Math.tan(fov/2.0),
            -1.0
        ];
        var mpx = vr[0] * this.camera.distance;
        var mpy = vr[1] * this.camera.distance;
        var mvx = mpx - this.lastMousePlaneX;
        var mvy = mpy - this.lastMousePlaneY;
        if (this.camera.isMouseDown()) { mvx = 0; mvy = 0; }
        this.lastMousePlaneX = mpx;
        this.lastMousePlaneY = mpy;

        var vm = this.camera.getViewMatrix();
        var ivm = Utilities.invertMatrix([], vm);
        var wr = Utilities.transformDirectionByMatrix([], vr, ivm);
        Utilities.normalizeVector(wr, wr);

        var cr = [vm[0], vm[4], vm[8]];
        var cu = [vm[1], vm[5], vm[9]];
        var mv = [];
        for (var i = 0; i < 3; i++) mv[i] = mvx * cr[i] + mvy * cu[i];

        return { mouseVelocity: mv, mouseRayOrigin: this.camera.getPosition(), mouseRayDirection: wr };
    };

    SplatFluid.prototype.drawSplats = function (opts) {
        var wgl = this.wgl;

        wgl.clear(
            wgl.createClearState().bindFramebuffer(null).clearColor(0.95, 0.95, 0.95, 1.0),
            wgl.COLOR_BUFFER_BIT | wgl.DEPTH_BUFFER_BIT);

        var drawState = wgl.createDrawState()
            .bindFramebuffer(null)
            .viewport(0, 0, this.canvas.width, this.canvas.height)
            .disable(wgl.DEPTH_TEST)
            .enable(wgl.BLEND)
            .blendFunc(wgl.ONE, wgl.ONE_MINUS_SRC_ALPHA)
            .useProgram(this.splatProgram)

            .vertexAttribPointer(this.quadVertexBuffer, 0, 2, wgl.FLOAT, wgl.FALSE, 0, 0)
            .vertexAttribPointer(opts.texCoordBuffer, 1, 2, wgl.FLOAT, wgl.FALSE, 0, 0)
            .vertexAttribDivisorANGLE(1, 1)

            .uniformMatrix4fv('u_projectionMatrix', false, this.projectionMatrix)
            .uniformMatrix4fv('u_viewMatrix', false, this.camera.getViewMatrix())

            .uniformTexture('u_positionsTexture', 0, wgl.TEXTURE_2D, opts.positionTexture)
            .uniformTexture('u_covATexture', 1, wgl.TEXTURE_2D, opts.covATexture)
            .uniformTexture('u_covBTexture', 2, wgl.TEXTURE_2D, opts.covBTexture)
            .uniformTexture('u_colorsTexture', 3, wgl.TEXTURE_2D, opts.colorTexture)

            .uniform2f('u_viewport', this.canvas.width, this.canvas.height)
            .uniform3f('u_gridMin', 0, 0, 0)
            .uniform3f('u_gridMax', this.gridWidth, this.gridHeight, this.gridDepth)
            .uniform3f('u_gridCenter', this.gridWidth/2, this.gridHeight/2, this.gridDepth/2)
            .uniform1f('u_applyScale', opts.applyScale)
            .uniform1f('u_splatScale', this.splatScale)
            .uniform1f('u_covScale', opts.covScale)
            .uniform3f('u_positionOffset', this.positionOffset[0], this.positionOffset[1], this.positionOffset[2]);

        wgl.drawArraysInstancedANGLE(drawState, wgl.TRIANGLE_STRIP, 0, 4, opts.count);
    };

    SplatFluid.prototype.update = function (deltaTime) {
        if (this.state === State.PREVIEW) {
            var cs = this.splatScale * this.splatScale * this.pointSizeScale * this.pointSizeScale;
            this.drawSplats({
                positionTexture: this.positionTexture,
                covATexture: this.covATexture,
                covBTexture: this.covBTexture,
                colorTexture: this.colorTexture,
                texCoordBuffer: this.texCoordBuffer,
                count: this.splatCount,
                applyScale: 1.0,
                covScale: cs
            });

        } else if (this.state === State.SIMULATING) {
            var mouse = this.getMouseInteraction();
            this.simulator.simulate(this.timeStep, mouse.mouseVelocity, mouse.mouseRayOrigin, mouse.mouseRayDirection);
            var cs = this.lockedCovScale * this.pointSizeScale * this.pointSizeScale;
            this.drawSplats({
                positionTexture: this.simulator.particlePositionTexture,
                covATexture: this.simCovATexture,
                covBTexture: this.simCovBTexture,
                colorTexture: this.simColorTexture,
                texCoordBuffer: this.simTexCoordBuffer,
                count: this.simParticleCount,
                applyScale: 0.0,
                covScale: cs
            });
        }
    };

    return SplatFluid;
}());
