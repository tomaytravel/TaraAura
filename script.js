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

    // --- Random Function ---
    float random (vec2 st) {
        return fract(sin(dot(st.xy, vec2(12.9898,78.233))) * 43758.5453123);
    }

    void main() {
        vec2 uv = vUv;
        vec4 texColor = texture2D(tDiffuse, uv);
        float alpha = texColor.a;

        // --- Timeline Factors ---
        float growthPhase = smoothstep(0.0, 8.0, uTime); 
        float lockPhase = smoothstep(60.0, 62.0, uTime); 
        float activeTime = uTime * (1.0 - lockPhase * 0.95);
        
        // --- Output Variables ---
        float auraAlpha = 0.0;
        vec3 auraColor = vec3(1.0, 0.8, 0.4); // 기본 금색

        // ==========================================
        // TYPE 0 & 3: Basic & Fade (Radial Expansion)
        // ==========================================
        if (uType == 0 || uType == 3) {
            float maxDist = uAuraSize * growthPhase;
            const int SAMPLES = 12;
            float noiseVal = snoise(uv * 3.0 + activeTime * uSwim) * 0.02;
            
            float accumulatedAlpha = 0.0;
            
            for(int i=0; i<SAMPLES; i++) {
                float angle = float(i) * 6.28318 / float(SAMPLES);
                // Basic: 원형으로 샘플링하여 확장
                vec2 offset = vec2(cos(angle), sin(angle)) * maxDist;
                
                // Breath effect
                offset *= 1.0 + sin(activeTime * 2.0 * uBreath) * 0.15;
                // Swim effect
                offset += vec2(noiseVal);

                accumulatedAlpha += texture2D(tDiffuse, uv + offset).a;
            }
            // 평균화
            auraAlpha = accumulatedAlpha / float(SAMPLES);
            
            // 본체 영역 빼기 (테두리만 남김)
            auraAlpha = clamp(auraAlpha - alpha * 1.5, 0.0, 1.0);

            // [TYPE 3: Fade Logic] 연기처럼 테두리가 사라짐
            if (uType == 3) {
                // 노이즈를 사용하여 외곽을 깎아먹음 (Erosion)
                float fadeNoise = snoise(uv * 10.0 + vec2(0.0, -activeTime * 0.5));
                float rimDist = auraAlpha; // 가장자리가 옅음
                
                // Fade Cycle: 시간에 따라 침식 범위가 변함
                float cycle = (sin(activeTime) + 1.0) * 0.5; 
                
                // alpha 값이 낮은(외곽) 부분부터 투명해지도록 step 적용
                float smokeMask = smoothstep(0.2 + cycle * 0.5, 0.8, rimDist + fadeNoise * 0.3);
                auraAlpha *= smokeMask;
            }
        }

        // ==========================================
        // TYPE 1: Flame (Upward Distortion)
        // ==========================================
        else if (uType == 1) {
            // UV를 위쪽으로 왜곡시킴 (Displacement)
            // 노이즈가 위로 흐르도록 함
            vec2 flameUV = uv;
            
            // Y축으로 갈수록 X축을 흔듬 (아지랑이)
            float heat = snoise(vec2(uv.x * 5.0, uv.y * 2.0 - activeTime * 2.0 * uSwim));
            flameUV.x += heat * 0.02;
            
            // 아래쪽 샘플링 (자신의 아래에 있는 픽셀을 가져옴 -> 위로 올라가는 효과)
            float flameSize = uAuraSize * growthPhase * uFlameHeight * 3.0;
            float fireDist = 0.0;
            
            // 수직 방향으로 여러번 샘플링하여 잔상(꼬리)를 만듬
            for(int i=1; i<=8; i++) {
                float f = float(i) / 8.0;
                // 아래쪽 좌표를 바라봄
                vec2 samplePos = flameUV - vec2(0.0, f * flameSize);
                
                // 위로 갈수록 좌우로 더 퍼지게
                float spreadNoise = snoise(vec2(activeTime, float(i))) * 0.05 * f;
                samplePos.x += spreadNoise;

                float sampleAlpha = texture2D(tDiffuse, samplePos).a;
                
                // 거리에 따라 감쇠 (위쪽일수록 연하게)
                fireDist += sampleAlpha * (1.0 - f); 
            }
            
            fireDist /= 3.0; // 강도 조절
            auraAlpha = clamp(fireDist - alpha, 0.0, 1.0);
            
            // 불꽃 끝부분을 날카롭게 (Threshold)
            float flameShape = smoothstep(0.2, 0.5, auraAlpha);
            auraAlpha = flameShape * uStrength;

            // 불꽃 색상 (온도에 따라 변화)
            vec3 hotColor = vec3(1.0, 0.9, 0.2); // 노랑
            vec3 coolColor = vec3(1.0, 0.1, 0.0); // 빨강
            auraColor = mix(coolColor, hotColor, heat * 0.5 + 0.5 + uFlameTemp * 0.5);
        }

        // ==========================================
        // TYPE 2: Drop (Radial Particles)
        // ==========================================
        else if (uType == 2) {
            // 본체 확장이 아님. 완전히 독립된 파티클 생성
            // 1. Polar Coordinates 변환
            vec2 center = vec2(0.5);
            vec2 toCenter = uv - center;
            float radius = length(toCenter);
            float angle = atan(toCenter.y, toCenter.x);
            
            // 2. Grid 생성 (방사형)
            // 시간에 따라 밖으로 밀어냄 (-activeTime)
            float radialMove = radius * (10.0 / uDropSize) - activeTime * uDropSpeed * 3.0;
            
            // 3. 셀 나누기
            float cellIndex = floor(radialMove);
            float cellLocal = fract(radialMove); // 0~1 (하나의 물방울 내 진행도)
            
            // 4. 각 셀마다 랜덤성 부여 (물방울이 드문드문 나오게)
            // 각도와 셀 인덱스를 섞어 랜덤값 생성
            float randomVal = random(vec2(floor(angle * 5.0), cellIndex));
            
            // 5. 물방울 모양 만들기
            // cellLocal이 0.5 근처일 때 밝음 (원형 펄스)
            float dropShape = smoothstep(0.4, 0.5, cellLocal) * smoothstep(0.6, 0.5, cellLocal);
            
            // 랜덤값이 특정 임계값을 넘을 때만 물방울 생성 (밀도 조절)
            float exist = step(0.7, randomVal); 
            
            // 6. 방향 제어 (옵션)
            // 기본은 방사형(radial)이지만, uDropDir가 있으면 그쪽 마스크를 씌움
            float dirMask = 1.0;
            if (length(uDropDir) > 0.1) {
                vec2 normDir = normalize(uDropDir);
                float dotDir = dot(normalize(toCenter), normDir);
                dirMask = smoothstep(0.0, 0.5, dotDir); // 방향에 맞는 쪽만 보임
            }

            // 7. 본체 내부에는 안 생기게 마스킹
            // 타라 본체보다 조금 바깥부터 시작
            float bodyDist = 0.0;
            // 간단히 원형 거리로 체크하거나, 텍스처 알파를 반전시켜 곱함
            float safeZone = smoothstep(0.1, 0.3, radius); 

            auraAlpha = dropShape * exist * dirMask * safeZone * uStrength;
            
            // 본체 위에는 그리지 않음
            auraAlpha *= (1.0 - alpha);
            
            // 물방울 색상 (약간 청록색)
            auraColor = vec3(0.4, 0.8, 1.0);
        }

        // ==========================================
        // 공통: 색상 수렴 및 최종 합성
        // ==========================================
        
        // Green Convergence Logic
        vec3 hsv = rgb2hsv(auraColor);
        float targetHue = 0.33; // Green
        // 시간이 지날수록(growthPhase), 수렴강도(uConv)에 따라 녹색으로
        hsv.x = mix(hsv.x, targetHue, uConv * growthPhase * 0.8);
        auraColor = hsv2rgb(hsv);

        // Final Aura Color apply
        vec3 finalAura = auraColor * auraAlpha;

        // Core Brightness (Lock Phase에 밝아짐)
        float brightness = uCore + (lockPhase * 0.5);
        vec3 bodyColor = texColor.rgb * brightness;

        // Composition: (Aura * Alpha) + (Body * Alpha)
        // Premultiplied Alpha blending 느낌으로 합성
        vec3 finalColor = finalAura + bodyColor * alpha;
        float finalAlpha = max(auraAlpha, alpha);

        gl_FragColor = vec4(finalColor, finalAlpha);
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
