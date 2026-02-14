import * as THREE from 'three';

// --- Global Variables ---
let scene, camera, renderer, material, mesh;
let textureLoader;
let clock;
let isPaused = false;
let currentTime = 0;
let currentType = 0; // 0:Basic, 1:Flame, 2:Ripple, 3:Fade, 4:Droplet

// --- Parameter Defaults ---
const params = {
    auraSize: 0.20,
    auraStrength: 1.5,
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

// --- Fragment Shader (Hollow, Slow, Wobbling Droplets) ---
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

    // Caustics Pattern (Net)
    float caustics(vec2 p, float t) {
        vec2 q = p;
        q.x += fbm(p + t * 0.1);
        q.y += fbm(p - t * 0.1);
        float n = fbm(q * 3.0);
        float net = 1.0 - abs(n * 2.0 - 1.0);
        net = pow(net, 3.0); 
        return net;
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

        // Center coordinates
        vec2 center = vec2(0.5);
        vec2 toCenter = uv - center;
        float radius = length(toCenter);
        float angle = atan(toCenter.y, toCenter.x);
        float normAngle = (angle / 6.28318) + 0.5;

        // ==========================================
        // TYPE 1: Thangka Flame
        // ==========================================
        if (uType == 1) {
            float baseDist = uAuraSize * growthPhase * 2.5; 
            float borderMask = 0.0;
            
            vec2 polarUV = vec2(normAngle * 6.0, radius);
            vec2 q = polarUV;
            q.x += fbm(polarUV * 3.0 + activeTime * 0.5) * 0.2;
            q.y -= activeTime * uSwim; 
            float shapeNoise = fbm(q * vec2(5.0, 1.0)); 
            
            const int SAMPLES = 16;
            for(int i=0; i<SAMPLES; i++) {
                float a = float(i) * 6.28318 / float(SAMPLES);
                float reach = baseDist * (0.5 + 1.5 * shapeNoise); 
                vec2 offset = vec2(cos(a), sin(a)) * reach * 0.5; 
                borderMask = max(borderMask, texture2D(tDiffuse, uv + offset).a);
            }
            borderMask = smoothstep(0.1, 0.6, borderMask);

            float detailNoise = fbm(q * vec2(10.0, 2.0)); 
            float flameVis = borderMask * detailNoise;
            flameVis = smoothstep(0.1, 0.9, flameVis); 
            
            auraAlpha = flameVis * uStrength;

            vec3 c1 = vec3(0.5, 0.0, 0.0);
            vec3 c2 = vec3(1.0, 0.3, 0.0);
            vec3 c3 = vec3(1.0, 0.9, 0.1);
            
            vec3 fireCol = mix(c1, c2, smoothstep(0.0, 0.5, detailNoise));
            fireCol = mix(fireCol, c3, smoothstep(0.5, 1.0, detailNoise));
            
            vec3 hsvF = rgb2hsv(fireCol);
            hsvF.x += (uFlameTemp - 0.5) * 0.4;
            auraColor = hsv2rgb(hsvF);
        }

        // ==========================================
        // TYPE 4: Hollow Droplet + Liquid Aura Border
        // ==========================================
        else if (uType == 4) {
            // [LAYER 1] Background (Same as before)
            vec2 warpUV = uv;
            float wave = fbm(uv * 3.0 + activeTime * uSwim * 0.5); 
            warpUV += (vec2(wave) - 0.5) * 0.05; 

            float bgDist = uAuraSize * 2.5; 
            float bgMask = 0.0;
            const int SAMPLES = 12;
            for(int i=0; i<SAMPLES; i++) {
                float a = float(i) * 6.28318 / float(SAMPLES);
                vec2 offset = vec2(cos(a), sin(a)) * bgDist;
                bgMask = max(bgMask, texture2D(tDiffuse, warpUV + offset).a);
            }
            bgMask = smoothstep(0.2, 0.6, bgMask); 

            vec2 waterUV = vec2(normAngle * 8.0, radius * 2.0 - activeTime * 0.2);
            float netPattern = caustics(waterUV, activeTime * 0.5);
            float bgAlpha = bgMask * netPattern * 0.4 * uStrength;

            // [LAYER 2] Hollow, Slow, Wobbling Droplets
            float dropsAlpha = 0.0;
            const float NUM_DROPS = 15.0; 
            
            for(float i = 0.0; i < NUM_DROPS; i++) {
                float seed = i * 17.54;
                
                // [FIX 2] Dramatically slower speed (0.08 mult)
                float speedVar = 0.5 + hash(vec2(seed, 1.0)) * 0.5;
                float t = activeTime * uDropSpeed * 0.08 * speedVar + seed; 
                
                float cycle = fract(t); 
                float cycleIdx = floor(t);
                
                float rndAngle = hash(vec2(seed, cycleIdx)) * 6.28318;
                float travelDist = cycle * 2.0; 
                vec2 dropPos = center + vec2(cos(rndAngle), sin(rndAngle)) * travelDist;
                
                // [FIX 3] Dynamic Shape Distortion (Wobble) based on Swim speed
                vec2 p = uv - dropPos; // Vector from center of drop
                
                // Wavelike breathing phase
                float wavePhase = activeTime * uSwim * 2.0 + cycleIdx * 1.1;
                
                // Squash and Stretch (changes width/height ratio rhythmically)
                float squashFactor = 1.0 + 0.25 * sin(wavePhase);
                // Apply opposite scaling to x and y to maintain roughly same area
                p.x *= sqrt(squashFactor);
                p.y /= sqrt(squashFactor);

                // Overall size fluctuation (breathing)
                float sizeBreath = 1.0 + 0.15 * cos(wavePhase * 0.7);
                
                // Modified distance based on distorted vector
                float d = length(p) / sizeBreath;


                // [FIX 1] Hollow Ring Shape & Reduced Size
                float rndScale = 0.3 + 0.7 * hash(vec2(seed, 9.9));
                // Reduced base size multiplier slightly (0.2 -> 0.15)
                float outerRadius = uDropSize * 0.15 * rndScale * (1.0 - cycle * 0.6);
                
                // Ring thickness relative to radius
                float ringThickness = outerRadius * 0.05; 
                float innerRadius = outerRadius - ringThickness;

                float edge = 0.005; // Sharpness

                // Create Ring: Outer Circle - Inner Circle
                float outerCircle = smoothstep(outerRadius, outerRadius - edge, d);
                float innerHole = smoothstep(innerRadius - edge, innerRadius, d);
                float ring = outerCircle * innerHole;

                // Fade out
                ring *= smoothstep(1.0, 0.85, cycle);
                
                dropsAlpha = max(dropsAlpha, ring);
            }

            // [COMBINE]
            auraAlpha = max(bgAlpha, dropsAlpha * uStrength);
            
            // Color Logic (Simpler cyan for rings)
            vec3 waterBlue = vec3(0.0, 0.6, 1.0); 
            vec3 brightCyan = vec3(0.2, 1.0, 1.0); 
            
            // Rings are bright cyan, background is deeper blue
            auraColor = mix(waterBlue, brightCyan, smoothstep(0.0, 0.5, dropsAlpha));
        }

        // ==========================================
        // TYPE 2: Ripple (Old "Droplet")
        // ==========================================
        else if (uType == 2) { 
            float maxDist = uAuraSize * 2.0; 
            float borderMask = 0.0;
            for(int i=0; i<8; i++) {
                float a = float(i) * 6.28318 / 8.0;
                vec2 offset = vec2(cos(a), sin(a)) * maxDist * 0.8;
                borderMask = max(borderMask, texture2D(tDiffuse, uv + offset).a);
            }
            borderMask = smoothstep(0.1, 0.5, borderMask);

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
        // Final Composition
        // ==========================================
        
        if (uType != 4) {
            vec3 hsv = rgb2hsv(auraColor);
            float targetHue = 0.33; 
            hsv.x = mix(hsv.x, targetHue, uConv * growthPhase * 0.8);
            auraColor = hsv2rgb(hsv);
        }

        float brightness = uCore + (lockPhase * 0.5);
        vec3 bodyColor = texColor.rgb * brightness;

        vec3 finalAura = auraColor * auraAlpha;
        vec3 finalColor = finalAura;
        
        // Halo Blending (Body on top)
        finalColor = mix(finalColor, bodyColor, alpha);

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
    } else if (currentType === 2 || currentType === 4) { // Ripple or Droplet
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
