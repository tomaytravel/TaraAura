import * as THREE from 'three';

// --- 전역 변수 ---
let scene, camera, renderer, material, mesh;
let textureLoader;
let clock;
let isPaused = false;
let currentTime = 0;
let currentType = 0; // 0:Basic, 1:Flame, 2:Drop, 3:Fade

// --- 파라미터 기본값 ---
const params = {
    auraSize: 0.15,
    auraStrength: 0.8,
    swimSpeed: 0.5,
    breathSpeed: 0.3,
    convergence: 0.5, // Green convergence
    coreBrightness: 1.0,
    // Type specifics
    flameHeight: 0.5,
    flameTemp: 0.5,
    dropSpeed: 1.0,
    dropSize: 0.5,
    dropDirX: 0.0,
    dropDirY: 1.0
};

// --- Vertex Shader (기본) ---
const vertexShader = `
    varying vec2 vUv;
    void main() {
        vUv = uv;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
`;

// --- Fragment Shader (핵심 로직) ---
const fragmentShader = `
    uniform sampler2D tDiffuse;
    uniform float uTime;
    uniform vec2 uResolution;
    uniform int uType; // 0:Basic, 1:Flame, 2:Drop, 3:Fade
    
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
    vec3 permute(vec3 x) { return mod(((x*34.0)+1.0)*x, 289.0); }
    float snoise(vec2 v){
        const vec4 C = vec4(0.211324865405187, 0.366025403784439, -0.577350269189626, 0.024390243902439);
        vec2 i  = floor(v + dot(v, C.yy) );
        vec2 x0 = v -   i + dot(i, C.xx);
        vec2 i1;
        i1 = (x0.x > x0.y) ? vec2(1.0, 0.0) : vec2(0.0, 1.0);
        vec4 x12 = x0.xyxy + C.xxzz;
        x12.xy -= i1;
        i = mod(i, 289.0);
        vec3 p = permute( permute( i.y + vec3(0.0, i1.y, 1.0 )) + i.x + vec3(0.0, i1.x, 1.0 ));
        vec3 m = max(0.5 - vec3(dot(x0,x0), dot(x12.xy,x12.xy), dot(x12.zw,x12.zw)), 0.0);
        m = m*m ;
        m = m*m ;
        vec3 x = 2.0 * fract(p * C.www) - 1.0;
        vec3 h = abs(x) - 0.5;
        vec3 ox = floor(x + 0.5);
        vec3 a0 = x - ox;
        m *= 1.79284291400159 - 0.85373472095314 * ( a0*a0 + h*h );
        vec3 g;
        g.x  = a0.x  * x0.x  + h.x  * x0.y;
        g.yz = a0.yz * x12.xz + h.yz * x12.yw;
        return 130.0 * dot(m, g);
    }

    // --- RGB to HSV & Back ---
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
        
        // --- Timeline Logic ---
        // 0-8s: Growth, >60s: Lock
        float timeFactor = uTime;
        float growthPhase = smoothstep(0.0, 8.0, uTime); // 0 to 1 over 8 sec
        float lockPhase = smoothstep(60.0, 62.0, uTime); // 0 to 1 after 60 sec
        
        // Lock phase reduces movement
        float activeTime = uTime * (1.0 - lockPhase * 0.95); 
        float activeSwim = uSwim * (1.0 - lockPhase);

        // --- Aura Generation (Distance Field approx) ---
        float alpha = texColor.a;
        float dist = 0.0;
        float maxDist = uAuraSize * growthPhase; // Grow over time
        
        // Simple radial sampling for outline thickness
        // Note: For a real SDF we'd precompute, but this acts as dynamic glow
        const int SAMPLES = 16;
        float noiseVal = snoise(uv * 5.0 + activeTime * uSwim) * 0.05;
        
        for(int i=0; i<SAMPLES; i++) {
            float angle = float(i) * 6.28318 / float(SAMPLES);
            vec2 offset = vec2(cos(angle), sin(angle)) * maxDist;
            
            // Apply breathing
            offset *= 1.0 + sin(activeTime * 2.0 * uBreath) * 0.1;
            
            // Add noise distortion to sampling
            offset += vec2(noiseVal * 0.5);

            float neighborAlpha = texture2D(tDiffuse, uv + offset).a;
            dist = max(dist, neighborAlpha);
        }
        
        // Cut out the original image
        float auraMask = dist - alpha;
        auraMask = clamp(auraMask, 0.0, 1.0);

        // --- Aura Coloring ---
        vec3 auraColor = vec3(1.0, 0.9, 0.5); // Default Gold/Light
        
        // Green Convergence Logic (Target Hue ~0.33)
        vec3 hsv = rgb2hsv(auraColor);
        // Mix current hue towards green based on uConv and Time
        float targetHue = 0.33; 
        // Oscillate hue during growth, stabilize later
        float hueNoise = snoise(vec2(uTime * 0.1, 0.0)) * 0.1 * (1.0 - lockPhase);
        hsv.x = mix(hsv.x, targetHue, uConv * growthPhase) + hueNoise;
        auraColor = hsv2rgb(hsv);

        // --- Type Specific Logic ---
        if (uType == 1) { // Flame
            float flame = snoise(vec2(uv.x * 10.0, activeTime * 2.0));
            float verticalFade = smoothstep(0.0, uFlameHeight, dist);
            auraMask *= (1.0 + flame * 0.5) * verticalFade;
            // Temp affects color (Red -> Orange -> Greenish)
            auraColor = mix(vec3(1.0, 0.2, 0.0), vec3(0.2, 1.0, 0.2), uFlameTemp);
        } 
        else if (uType == 2) { // Droplet
            vec2 center = vec2(0.5);
            vec2 dir = normalize(uv - center);
            // Use custom direction if defined length > 0
            if (length(uDropDir) > 0.1) dir = normalize(uDropDir);
            
            float dropDist = dot(uv - center, dir);
            float rings = sin(dropDist * 20.0 / uDropSize - activeTime * uDropSpeed * 5.0);
            float ringMask = smoothstep(0.8, 1.0, rings);
            
            // Only show drops outside the body
            auraMask = ringMask * (1.0 - alpha) * dist; 
        }
        else if (uType == 3) { // Fade Away
            float fadeCycle = sin(activeTime * 2.0);
            auraMask *= smoothstep(-1.0, 1.0, fadeCycle);
        }

        // Apply Strength
        auraMask *= uStrength;

        // --- Final Composition ---
        vec3 finalColor = mix(vec3(0.0), auraColor, auraMask);
        
        // Add Original Image on top
        // Core Brightness boost during Lock Phase
        float brightness = uCore + (lockPhase * 0.2); 
        vec3 bodyColor = texColor.rgb * brightness;
        
        finalColor = mix(finalColor, bodyColor, alpha);

        gl_FragColor = vec4(finalColor, max(alpha, auraMask));
    }
`;

// --- 초기화 함수 ---
function init() {
    const container = document.getElementById('canvas-container');

    // 씬 설정
    scene = new THREE.Scene();

    // 직교 카메라 (2D 이미지 처리에 적합)
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

    // 기본 이미지 로드
    loadTexture('tara.png');

    // 이벤트 리스너 연결
    window.addEventListener('resize', onWindowResize);
    setupUI();
    
    // 애니메이션 루프 시작
    animate();
}

function loadTexture(url) {
    textureLoader.load(url, (texture) => {
        texture.minFilter = THREE.LinearFilter;
        texture.magFilter = THREE.LinearFilter;

        // 기존 메쉬가 있으면 제거
        if (mesh) scene.remove(mesh);

        // 이미지 비율에 맞춰 PlaneGeometry 생성
        const imgAspect = texture.image.width / texture.image.height;
        const geometry = new THREE.PlaneGeometry(1 * imgAspect, 1);

        // 쉐이더 머티리얼 설정
        material = new THREE.ShaderMaterial({
            uniforms: {
                tDiffuse: { value: texture },
                uTime: { value: 0.0 },
                uResolution: { value: new THREE.Vector2(window.innerWidth, window.innerHeight) },
                uType: { value: currentType },
                
                // Sliders
                uAuraSize: { value: params.auraSize },
                uStrength: { value: params.auraStrength },
                uSwim: { value: params.swimSpeed },
                uBreath: { value: params.breathSpeed },
                uConv: { value: params.convergence },
                uCore: { value: params.coreBrightness },
                
                // Type Specific
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
        
        // 카메라 줌 조정 (이미지가 화면에 꽉 차게)
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

// --- UI 설정 ---
function setupUI() {
    // 1. 파일 업로드 & 드래그 앤 드롭
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

    // 2. 버튼
    document.getElementById('btn-restart').addEventListener('click', () => {
        currentTime = 0;
        isPaused = false;
    });
    document.getElementById('btn-pause').addEventListener('click', () => {
        isPaused = !isPaused;
    });
    document.getElementById('btn-reset').addEventListener('click', (e) => {
        if (e.shiftKey) currentTime = 0; // Shift+Reset: 타임라인도 리셋
        resetParams();
    });

    // 3. 타입 선택
    const typeBtns = document.querySelectorAll('.type-btn');
    typeBtns.forEach(btn => {
        btn.addEventListener('click', (e) => {
            typeBtns.forEach(b => b.classList.remove('active'));
            e.target.classList.add('active');
            currentType = parseInt(e.target.dataset.type);
            updateSliders(); // 타입에 맞는 슬라이더 갱신
            if(material) material.uniforms.uType.value = currentType;
        });
    });

    // 4. 슬라이더 생성
    updateSliders();
}

function handleFileSelect(e) {
    if (e.target.files.length) handleFile(e.target.files[0]);
}

function handleFile(file) {
    const reader = new FileReader();
    reader.onload = (e) => {
        loadTexture(e.target.result);
        currentTime = 0; // 새 이미지 로드 시 애니메이션 리셋
    };
    reader.readAsDataURL(file);
}

// 슬라이더 동적 생성 (타입별 표시)
function updateSliders() {
    const container = document.getElementById('slider-container');
    container.innerHTML = '';

    // 공통 파라미터
    createSlider(container, '아우라 크기 (Size)', 'auraSize', 0, 0.5);
    createSlider(container, '강도 (Strength)', 'auraStrength', 0, 2.0);
    createSlider(container, '유영 (Swim)', 'swimSpeed', 0, 2.0);
    createSlider(container, '호흡 (Breath)', 'breathSpeed', 0, 2.0);
    createSlider(container, '색상 수렴 (Conv)', 'convergence', 0, 1.0);
    createSlider(container, '코어 밝기 (Core)', 'coreBrightness', 0.5, 2.0);

    // 타입별 파라미터
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
        
        // 쉐이더 유니폼 즉시 업데이트
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
    // 기본값 복구 (실제 구현시 초기값을 복사해두는게 좋음. 여기선 하드코딩된 값으로 예시)
    params.auraSize = 0.15;
    params.auraStrength = 0.8;
    // ... 나머지 초기화 로직 필요
    updateSliders();
    // 쉐이더 값도 갱신 필요
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

// 시작
init();
