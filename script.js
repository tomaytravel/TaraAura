import * as THREE from 'three';

// --- Global Variables ---
let scene, camera, renderer, material, mesh;
let textureLoader;
let clock;
let isPaused = false;
let currentTime = 0;
let currentType = 0; // 0:Basic, 1:Flame, 2:Drop, 3:Fade

// --- Parameter Defaults ---
const params = {
    auraSize: 0.20, // 사이즈 약간 키움 (후광 효과 극대화)
    auraStrength: 1.5, // 강도 증가
    swimSpeed: 0.5,
    breathSpeed: 0.3,
    convergence: 0.5, 
    coreBrightness: 1.0,
    // Type specifics
    flameHeight: 0.5,
    flameTemp: 0.5,
    dropSpeed: 1.0,
    dropSize: 0.5,
    dropDirX: 0.0,
    dropDirY: 1.0
};

// --- Vertex Shader ---
const vertexShader = `
    varying vec2 vUv;
    void main() {
        vUv = uv;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
`;

// --- Fragment Shader (Shape Distortion & Halo Layering) ---
const fragmentShader = `
    precision mediump float;
    uniform sampler2D tDiffuse;
    uniform float uTime;
    uniform vec2 uResolution;
    uniform int uType;
    
    // Sliders
    uniform float uAuraSize;
    uniform float uStrength;
    uniform float uSwim;
    uniform float uBreath;
    uniform float uConv;
    uniform float uCore;
    
    // Type specific
    uniform float uFlameHeight;
    uniform float uFlameTemp;
    uniform float uDropSpeed;
    uniform float uDropSize;
    uniform vec2 uDropDir;

    varying vec2 vUv;

    // --- Noise Functions ---
    float hash(vec2 p) {
        return fract(sin(dot(p, vec2(12.123, 78.233))) * 43758.5453);
    }

    float noise(vec2 p) {
        vec2 i = floor(p);
        vec2 f = fract(p);
        f = f*f*(3.0-2.0*f);
        return mix(mix(hash(i + vec2(0.0,0.0)), hash(i + vec2(1.0,0.0)), f.x),
                   mix(hash(i + vec2(0.0,1.0)), hash(i + vec2(1.0,1.0)), f.x), f.y);
    }

    // FBM: Fine details
    float fbm(vec2 p) {
        float v = 0.0;
        float a = 0.5;
        for (int i = 0; i < 5; i++) {
            v += a * noise(p);
            p *= 2.0;
            a *= 0.5;
        }
        return v;
    }

    vec3 rgb2hsv(vec3 c) {
        vec4 K = vec4(0.0, -1.0 / 3.0, 2.0 / 3.0, -1.0);
        vec4 p = mix(vec4(c.bg, K.wz), vec4(c.gb, K.xy), step(c.b, c.g));
        vec4 q = mix(vec4(p.xyw, c.r), vec4(c.r, p.yzx), step(p.x, c.r));
        float d = q.x - min(q.w, q.y);
        float e = 1.0e-10;
        return vec3(abs(q.z + (q.w - q.y) / (6.0 * d + e)), d / (q.x + e), q.x);
    }

    vec3 hsv2rgb(vec3 c) {
        vec4 K = vec4(1.0, 2.0 / 3.0, 1.0 / 3.0, 3.0);
        vec3 p = abs(fract(c.xxx + K.xyz) * 6.0 - K.www);
        return c.z * mix(K.xxx, clamp(p - K.xxx, 0.0, 1.0), c.y);
    }

    void main() {
        vec2 uv = vUv;
        vec4 texColor = texture2D(tDiffuse, uv);
        float alpha = texColor.a;

        float growthPhase = smoothstep(0.0, 8.0, uTime); 
        float lockPhase = smoothstep(60.0, 62.0, uTime); 
        float activeTime = uTime * (1.0 - lockPhase * 0.95);
        
        float auraAlpha = 0.0;
        vec3 auraColor = vec3(1.0, 0.8, 0.4); 

        // Center calc
        vec2 center = vec2(0.5);
        vec2 toCenter = uv - center;
        float radius = length(toCenter);
        float angle = atan(toCenter.y, toCenter.x);
        float normAngle = (angle / 6.28318) + 0.5;

        // ==========================================
        // TYPE 1: Thangka Flame (Shape Distortion)
        // ==========================================
        if (uType == 1) {
            // [Feature 1] Shape Sculpting via Dynamic Sampling
            // Instead of a fixed circle, we modulate the sampling distance with Noise.
            // This creates a jagged, irregular expansion (flames sticking out).
            
            float baseDist = uAuraSize * growthPhase * 2.5; 
            float borderMask = 0.0;
            
            // Polar FBM for distortion
            vec2 polarUV = vec2(normAngle * 6.0, radius);
            vec2 q = polarUV;
            q.x += fbm(polarUV * 3.0 + activeTime * 0.5) * 0.2;
            q.y -= activeTime * uSwim; 
            
            // Use this noise to distort the border SHAPE
            float shapeNoise = fbm(q * vec2(5.0, 1.0)); // Lower frequency for shape
            
            // Sampling loop
            const int SAMPLES = 16;
            for(int i=0; i<SAMPLES; i++) {
                float a = float(i) * 6.28318 / float(SAMPLES);
                
                // Dynamic Reach: Fire reaches further where noise is high
                // shapeNoise varies by angle, creating tongues of fire
                float reach = baseDist * (0.5 + 1.5 * shapeNoise); 
                
                vec2 offset = vec2(cos(a), sin(a)) * reach * 0.5; 
                borderMask = max(borderMask, texture2D(tDiffuse, uv + offset).a);
            }
            borderMask = smoothstep(0.1, 0.6, borderMask);

            // [Feature 2] Internal Detail Texture
            // High frequency FBM for fine strands inside the flame
            float detailNoise = fbm(q * vec2(10.0, 2.0)); 
            
            // Combine Shape & Detail
            float flameVis = borderMask * detailNoise;
            flameVis = smoothstep(0.1, 0.9, flameVis); // Increase contrast
            
            // Apply strength
            auraAlpha = flameVis * uStrength;

            // [Feature 3] Halo Layering (No hole punching)
            // We do NOT subtract alpha here. We will mix later.

            // Color Gradient
            vec3 c1 = vec3(0.5, 0.0, 0.0); // Deep Red
            vec3 c2 = vec3(1.0, 0.3, 0.0); // Orange
            vec3 c3 = vec3(1.0, 0.9, 0.1); // Yellow
            
            vec3 fireCol = mix(c1, c2, smoothstep(0.0, 0.5, detailNoise));
            fireCol = mix(fireCol, c3, smoothstep(0.5, 1.0, detailNoise));
            
            vec3 hsvF = rgb2hsv(fireCol);
            hsvF.x += (uFlameTemp - 0.5) * 0.4;
            auraColor = hsv2rgb(hsvF);
        }

        // ==========================================
        // TYPE 2: Droplet (Scattered Particles)
        // ==========================================
        else if (uType == 2) { 
            // Expand border
            float maxDist = uAuraSize * 2.0; 
            float borderMask = 0.0;
            for(int i=0; i<12; i++) {
                float a = float(i) * 6.28318 / 12.0;
                vec2 offset = vec2(cos(a), sin(a)) * maxDist * 0.8;
                borderMask = max(borderMask, texture2D(tDiffuse, uv + offset).a);
            }
            borderMask = smoothstep(0.1, 0.5, borderMask);

            // Mist Noise
            float radialMove = radius * (10.0 / uDropSize) - activeTime * uDropSpeed * 3.0;
            vec2 noiseUV = vec2(normAngle * 10.0, radialMove * 0.5);
            float fineDetail = fbm(noiseUV);
            
            float cellLocal = fract(radialMove);
            float dropShape = smoothstep(0.4, 0.5, cellLocal) * smoothstep(0.6, 0.5, cellLocal);
            
            float mist = borderMask * dropShape * fineDetail * 2.5;
            
            float dirMask = 1.0;
            if (length(uDropDir) > 0.1) {
                float dotDir = dot(normalize(toCenter), normalize(uDropDir));
                dirMask = smoothstep(0.0, 0.5, dotDir);
            }

            auraAlpha = mist * dirMask * uStrength;
            // No hole punching -> Halo effect
            auraColor = vec3(0.4, 0.8, 1.0);
        }

        // ==========================================
        // TYPE 0 & 3: Basic & Fade
        // ==========================================
        else {
            float maxDist = uAuraSize * growthPhase;
            const int SAMPLES = 12;
            float noiseVal = fbm(uv * 3.0 + activeTime * uSwim) * 0.1;
            float accumulatedAlpha = 0.0;
            for(int i=0; i<SAMPLES; i++) {
                float a = float(i) * 6.28318 / float(SAMPLES);
                vec2 offset = vec2(cos(a), sin(a)) * maxDist;
                offset *= 1.0 + sin(activeTime * 2.0 * uBreath) * 0.15;
                offset += vec2(noiseVal * 0.1);
                accumulatedAlpha += texture2D(tDiffuse, uv + offset).a;
            }
            auraAlpha = accumulatedAlpha / float(SAMPLES);
            
            if (uType == 3) {
                float fadeNoise = fbm(uv * 10.0 + vec2(0.0, -activeTime * 0.5));
                float cycle = (sin(activeTime) + 1.0) * 0.5; 
                float smokeMask = smoothstep(0.2 + cycle * 0.5, 0.8, auraAlpha + fadeNoise * 0.3);
                auraAlpha *= smokeMask;
            }
        }

        // ==========================================
        // Final Composition (Halo Effect)
        // ==========================================
        
        // Green Convergence (Global)
        vec3 hsv = rgb2hsv(auraColor);
        float targetHue = 0.33; 
        hsv.x = mix(hsv.x, targetHue, uConv * growthPhase * 0.8);
        auraColor = hsv2rgb(hsv);

        // Core Brightness
        float brightness = uCore + (lockPhase * 0.5);
        vec3 bodyColor = texColor.rgb * brightness;

        // [CORE FIX] Halo Layering Logic
        // Background (Aura) + Foreground (Body)
        // Result = Body * Alpha + Aura * (1 - Alpha) (Standard Blending)
        // But since user wants "Halo", we can additively blend or mix.
        // Let's use mix to simulate body blocking the aura (Backlight).
        
        vec3 finalAura = auraColor * auraAlpha;
        
        // 1. Draw Aura
        vec3 finalColor = finalAura;
        
        // 2. Draw Body on top (using body alpha)
        // This ensures the body covers the aura, creating the "behind" look.
        finalColor = mix(finalColor, bodyColor, alpha);

        // Final Alpha is max of both to keep shape
        float finalAlpha = max(auraAlpha, alpha);

        gl_FragColor = vec4(finalColor, finalAlpha);
    }
`;

// --- Initialization ---
function init() {
    const container = document.getElementById('canvas-container');

    scene = new THREE.Scene();

    const aspect = window.innerWidth / window.innerHeight;
    const frustumSize = 1;
    camera = new THREE.OrthographicCamera(
        frustumSize * aspect / -2, frustumSize * aspect / 2,
        frustumSize / 2, frustumSize / -2,
        0.1, 1000
    );
    camera.position.z = 1;

    renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.setPixelRatio(window.devicePixelRatio);
    container.appendChild(renderer.domElement);

    clock = new THREE.Clock();
    textureLoader = new THREE.TextureLoader();

    loadTexture('tara.png');

    window.addEventListener('resize', onWindowResize);
    setupUI();
    
    animate();
}

function loadTexture(url) {
    textureLoader.load(url, (texture) => {
        texture.minFilter = THREE.LinearFilter;
        texture.magFilter = THREE.LinearFilter;

        if (mesh) scene.remove(mesh);

        const imgAspect = texture.image.width / texture.image.height;
        const geometry = new THREE.PlaneGeometry(1 * imgAspect, 1);

        material = new THREE.ShaderMaterial({
            uniforms: {
                tDiffuse: { value: texture },
                uTime: { value: 0.0 },
                uResolution: { value: new THREE.Vector2(window.innerWidth, window.innerHeight) },
                uType: { value: currentType },
                
                uAuraSize: { value: params.auraSize },
                uStrength: { value: params.auraStrength },
                uSwim: { value: params.swimSpeed },
                uBreath: { value: params.breathSpeed },
                uConv: { value: params.convergence },
                uCore: { value: params.coreBrightness },
                
                uFlameHeight: { value: params.flameHeight },
                uFlameTemp: { value: params.flameTemp },
                uDropSpeed: { value: params.dropSpeed },
                uDropSize: { value: params.dropSize },
                uDropDir: { value: new THREE.Vector2(params.dropDirX, params.dropDirY) }
            },
            vertexShader: vertexShader,
            fragmentShader: fragmentShader,
            transparent: true
        });

        mesh = new THREE.Mesh(geometry, material);
        scene.add(mesh);
        
        const aspect = window.innerWidth / window.innerHeight;
        if (aspect > imgAspect) {
             camera.zoom = 1.0; 
        } else {
             camera.zoom = aspect / imgAspect;
        }
        camera.updateProjectionMatrix();

    }, undefined, (err) => {
        console.warn('tara.png를 찾을 수 없습니다. 이미지를 업로드해주세요.', err);
    });
}

// --- UI Setup ---
function setupUI() {
    const fileInput = document.getElementById('file-input');
    fileInput.addEventListener('change', handleFileSelect);

    const dropZone = document.body;
    dropZone.addEventListener('dragover', (e) => e.preventDefault());
    dropZone.addEventListener('drop', (e) => {
        e.preventDefault();
        if (e.dataTransfer.files.length) {
            handleFile(e.dataTransfer.files[0]);
        }
    });

    document.getElementById('btn-restart').addEventListener('click', () => {
        currentTime = 0;
        isPaused = false;
    });
    document.getElementById('btn-pause').addEventListener('click', () => {
        isPaused = !isPaused;
    });
    document.getElementById('btn-reset').addEventListener('click', (e) => {
        if (e.shiftKey) currentTime = 0;
        resetParams();
    });

    const typeBtns = document.querySelectorAll('.type-btn');
    typeBtns.forEach(btn => {
        btn.addEventListener('click', (e) => {
            typeBtns.forEach(b => b.classList.remove('active'));
            e.target.classList.add('active');
            currentType = parseInt(e.target.dataset.type);
            updateSliders(); 
            if(material) material.uniforms.uType.value = currentType;
        });
    });

    updateSliders();
}

function handleFileSelect(e) {
    if (e.target.files.length) handleFile(e.target.files[0]);
}

function handleFile(file) {
    const reader = new FileReader();
    reader.onload = (e) => {
        loadTexture(e.target.result);
        currentTime = 0; 
    };
    reader.readAsDataURL(file);
}

function updateSliders() {
    const container = document.getElementById('slider-container');
    container.innerHTML = '';

    createSlider(container, '아우라 크기 (Size)', 'auraSize', 0, 0.5);
    createSlider(container, '강도 (Strength)', 'auraStrength', 0, 2.0);
    createSlider(container, '유영 (Swim)', 'swimSpeed', 0, 2.0);
    createSlider(container, '호흡 (Breath)', 'breathSpeed', 0, 2.0);
    createSlider(container, '색상 수렴 (Conv)', 'convergence', 0, 1.0);
    createSlider(container, '코어 밝기 (Core)', 'coreBrightness', 0.5, 2.0);

    if (currentType === 1) { // Flame
        createSlider(container, '불꽃 높이 (Height)', 'flameHeight', 0.1, 1.0);
        createSlider(container, '온도 (Temp)', 'flameTemp', 0, 1.0);
    } else if (currentType === 2) { // Drop
        createSlider(container, '속도 (Speed)', 'dropSpeed', 0.1, 5.0);
        createSlider(container, '크기 (Size)', 'dropSize', 0.1, 2.0);
    }
}

function createSlider(parent, label, paramKey, min, max) {
    const wrapper = document.createElement('div');
    wrapper.className = 'slider-wrapper';
    
    const labelDiv = document.createElement('div');
    labelDiv.className = 'slider-label';
    labelDiv.innerHTML = `<span>${label}</span><span id="val-${paramKey}">${params[paramKey].toFixed(2)}</span>`;
    
    const input = document.createElement('input');
    input.type = 'range';
    input.min = min;
    input.max = max;
    input.step = 0.01;
    input.value = params[paramKey];
    
    input.addEventListener('input', (e) => {
        const val = parseFloat(e.target.value);
        params[paramKey] = val;
        document.getElementById(`val-${paramKey}`).innerText = val.toFixed(2);
        
        if (material) {
            switch(paramKey) {
                case 'auraSize': material.uniforms.uAuraSize.value = val; break;
                case 'auraStrength': material.uniforms.uStrength.value = val; break;
                case 'swimSpeed': material.uniforms.uSwim.value = val; break;
                case 'breathSpeed': material.uniforms.uBreath.value = val; break;
                case 'convergence': material.uniforms.uConv.value = val; break;
                case 'coreBrightness': material.uniforms.uCore.value = val; break;
                case 'flameHeight': material.uniforms.uFlameHeight.value = val; break;
                case 'flameTemp': material.uniforms.uFlameTemp.value = val; break;
                case 'dropSpeed': material.uniforms.uDropSpeed.value = val; break;
                case 'dropSize': material.uniforms.uDropSize.value = val; break;
            }
        }
    });

    wrapper.appendChild(labelDiv);
    wrapper.appendChild(input);
    parent.appendChild(wrapper);
}

function resetParams() {
    params.auraSize = 0.20;
    params.auraStrength = 1.5;
    params.swimSpeed = 0.5;
    params.breathSpeed = 0.3;
    params.convergence = 0.5;
    params.coreBrightness = 1.0;
    params.flameHeight = 0.5;
    params.flameTemp = 0.5;
    params.dropSpeed = 1.0;
    params.dropSize = 0.5;
    updateSliders();
    
    if (material) {
        material.uniforms.uAuraSize.value = params.auraSize;
        material.uniforms.uStrength.value = params.auraStrength;
        material.uniforms.uSwim.value = params.swimSpeed;
        material.uniforms.uBreath.value = params.breathSpeed;
        material.uniforms.uConv.value = params.convergence;
        material.uniforms.uCore.value = params.coreBrightness;
        material.uniforms.uFlameHeight.value = params.flameHeight;
        material.uniforms.uFlameTemp.value = params.flameTemp;
        material.uniforms.uDropSpeed.value = params.dropSpeed;
        material.uniforms.uDropSize.value = params.dropSize;
    }
}

function onWindowResize() {
    const aspect = window.innerWidth / window.innerHeight;
    const frustumSize = 1;

    camera.left = -frustumSize * aspect / 2;
    camera.right = frustumSize * aspect / 2;
    camera.top = frustumSize / 2;
    camera.bottom = -frustumSize / 2;

    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
    
    if(material) material.uniforms.uResolution.value.set(window.innerWidth, window.innerHeight);
}

function animate() {
    requestAnimationFrame(animate);

    const delta = clock.getDelta();
    if (!isPaused) {
        currentTime += delta;
    }

    if (material) {
        material.uniforms.uTime.value = currentTime;
    }

    document.getElementById('time-display').innerText = currentTime.toFixed(1);

    renderer.render(scene, camera);
}

// Start
init();
