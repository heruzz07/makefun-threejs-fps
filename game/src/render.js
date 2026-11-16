// Rendering only, rebuilt for the threejs-fps-02 pivot: builds the three.js scene from
// the shared map data and draws it. The sim never touches three.js; this module never
// touches game rules. It reads the single state store and the bot list each frame, and
// owns the tracer/smoke/muzzle/grenade pools.
//
// New in this pass: a gradient sky dome with a low sun and drifting clouds, warmer dusk
// sun + cool fill lighting, more map dressing (pipes along the Vent, floodlight poles,
// panel frames, the pump tank), a muzzle-flash point light, glow-paired tracers, visible
// grenades in flight, and a slow-motion hook for round ends.
import * as THREE from 'three';
import { CFG, TEAMS } from './config.js';
import { COLLIDERS, SITES } from './map.js';
import { mulberry32 } from './random.js';

const KIND_COLORS = {
  wall: 0xb39a7a,
  panel: 0x2a2f3a,
  container: 0xb5502a,
  crate: 0xa8824f,
  barrel: 0x8a4a2a,
  pumphouse: 0x9c8a6d,
  tank: 0x6a7a8a,
};

function sandTexture() {
  const c = document.createElement('canvas');
  c.width = 256;
  c.height = 256;
  const g = c.getContext('2d');
  g.fillStyle = '#c9a06a';
  g.fillRect(0, 0, 256, 256);
  const rng = mulberry32(1337);
  for (let i = 0; i < 2600; i += 1) {
    const v = rng();
    g.fillStyle = v < 0.5 ? 'rgba(120,90,55,0.16)' : 'rgba(235,205,150,0.14)';
    g.fillRect(rng() * 256, rng() * 256, 1 + rng() * 3, 1 + rng() * 3);
  }
  g.strokeStyle = 'rgba(110,85,55,0.10)';
  g.lineWidth = 1;
  for (let i = 0; i <= 8; i += 1) {
    g.beginPath(); g.moveTo(i * 32, 0); g.lineTo(i * 32, 256); g.stroke();
    g.beginPath(); g.moveTo(0, i * 32); g.lineTo(256, i * 32); g.stroke();
  }
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(16, 12);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// A radial-gradient sprite texture (sun glow, muzzle flash) drawn once and reused.
function radialTexture(inner, mid, outer) {
  const c = document.createElement('canvas');
  c.width = 128;
  c.height = 128;
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(64, 64, 2, 64, 64, 62);
  grad.addColorStop(0, inner);
  grad.addColorStop(0.4, mid);
  grad.addColorStop(1, outer);
  g.fillStyle = grad;
  g.fillRect(0, 0, 128, 128);
  return new THREE.CanvasTexture(c);
}

export function createRender(container, minimapCanvas, opts = {}) {
  const lowFx = !!opts.lowFx; // ?fx=low: no shadows, pixel ratio 1 (slow machines)
  const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(lowFx ? 1 : Math.min(window.devicePixelRatio, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.shadowMap.enabled = !lowFx;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.08;
  container.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  scene.fog = new THREE.Fog(0x2b3350, 30, 110);

  const camera = new THREE.PerspectiveCamera(74, window.innerWidth / window.innerHeight, 0.05, 400);
  scene.add(camera);

  // --- sky: a gradient dome, a low sun with a glow halo, drifting clouds ---------
  // The dome is a big sphere seen from inside; its shader blends indigo at the top
  // into burnt orange at the horizon, so the dusk reads even before any geometry.
  const skyMat = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    fog: false,
    depthWrite: false,
    uniforms: {},
    vertexShader: `
      varying vec3 vPos;
      void main() {
        vPos = position;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }`,
    fragmentShader: `
      varying vec3 vPos;
      void main() {
        float h = normalize(vPos).y;
        vec3 top = vec3(0.10, 0.13, 0.28);
        vec3 mid = vec3(0.45, 0.28, 0.38);
        vec3 low = vec3(0.95, 0.55, 0.28);
        vec3 col = h > 0.25 ? mix(mid, top, smoothstep(0.25, 0.85, h))
          : mix(low, mid, smoothstep(-0.08, 0.25, h));
        gl_FragColor = vec4(col, 1.0);
      }`,
  });
  const sky = new THREE.Mesh(new THREE.SphereGeometry(190, 24, 16), skyMat);
  scene.add(sky);

  // Dusk lighting: a warmer, lower sun from the west, cool indigo sky fill.
  const sun = new THREE.DirectionalLight(0xffa04e, 2.9);
  sun.position.set(-45, 13, -12);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.camera.left = -42;
  sun.shadow.camera.right = 42;
  sun.shadow.camera.top = 32;
  sun.shadow.camera.bottom = -32;
  sun.shadow.camera.far = 140;
  sun.shadow.bias = -0.0004;
  scene.add(sun);
  scene.add(new THREE.HemisphereLight(0x51619a, 0x9a7a52, 1.15));
  // A faint cool fill from the east so the shadow side never goes dead black.
  const fill = new THREE.DirectionalLight(0x6a7ab8, 0.35);
  fill.position.set(40, 20, 10);
  scene.add(fill);

  // Ground.
  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(CFG.mapW + 40, CFG.mapD + 40),
    new THREE.MeshStandardMaterial({ map: sandTexture(), roughness: 1 }),
  );
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  scene.add(ground);

  // Low sun disc on the western horizon + a soft glow halo around it.
  const sunDisc = new THREE.Mesh(
    new THREE.CircleGeometry(7, 32),
    new THREE.MeshBasicMaterial({ color: 0xffd9a0, fog: false }),
  );
  sunDisc.position.set(-70, 9, -30);
  sunDisc.lookAt(0, 6, 0);
  scene.add(sunDisc);
  const sunGlow = new THREE.Mesh(
    new THREE.PlaneGeometry(46, 46),
    new THREE.MeshBasicMaterial({
      map: radialTexture('rgba(255, 225, 170, 0.85)', 'rgba(255, 170, 80, 0.35)', 'rgba(255, 150, 60, 0)'),
      transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, fog: false,
    }),
  );
  sunGlow.position.set(-72, 10, -31);
  sunGlow.lookAt(0, 6, 0);
  scene.add(sunGlow);

  // Drifting clouds: flattened translucent puffs high over the yard.
  const clouds = [];
  const cloudMat = new THREE.MeshBasicMaterial({
    color: 0xd8c8e8, transparent: true, opacity: 0.32, fog: false, depthWrite: false,
  });
  const rng = mulberry32(4242);
  for (let i = 0; i < 7; i += 1) {
    const cloud = new THREE.Mesh(new THREE.SphereGeometry(6 + rng() * 7, 12, 8), cloudMat);
    cloud.scale.y = 0.28;
    cloud.position.set(-80 + rng() * 160, 42 + rng() * 18, -70 + rng() * 140);
    cloud.userData.speed = 0.4 + rng() * 0.5;
    scene.add(cloud);
    clouds.push(cloud);
  }

  // Distant dune silhouettes.
  const duneMat = new THREE.MeshStandardMaterial({ color: 0x8a6a4e, roughness: 1 });
  for (let i = 0; i < 6; i += 1) {
    const dune = new THREE.Mesh(new THREE.BoxGeometry(30 + rng() * 30, 3 + rng() * 4, 10), duneMat);
    const a = rng() * Math.PI * 2;
    dune.position.set(Math.cos(a) * 70, 0.5, Math.sin(a) * 70);
    dune.rotation.y = rng() * Math.PI;
    scene.add(dune);
  }

  // Map geometry from the shared collider list.
  const mats = {};
  function matFor(color) {
    if (!mats[color]) mats[color] = new THREE.MeshStandardMaterial({ color, roughness: 0.85 });
    return mats[color];
  }
  const siteRings = {};
  for (const c of COLLIDERS) {
    const w = c.x1 - c.x0;
    const d = c.z1 - c.z0;
    const cx = (c.x0 + c.x1) / 2;
    const cz = (c.z0 + c.z1) / 2;
    if (c.kind === 'panel') {
      // Low dark base + a tilted photovoltaic slab on a post, edged with a frame
      // so the rows read as built hardware instead of flat boxes.
      const base = new THREE.Mesh(new THREE.BoxGeometry(w, c.h * 0.45, d), matFor(0x2a2f3a));
      base.position.set(cx, c.h * 0.225, cz);
      base.castShadow = true;
      base.receiveShadow = true;
      scene.add(base);
      const slab = new THREE.Mesh(
        new THREE.BoxGeometry(w, 0.1, d * 1.5),
        new THREE.MeshStandardMaterial({ color: 0x1d2f5e, roughness: 0.35, metalness: 0.55 }),
      );
      slab.position.set(cx, c.h * 0.92, cz);
      slab.rotation.x = -0.42;
      slab.castShadow = true;
      scene.add(slab);
      const frame = new THREE.Mesh(
        new THREE.BoxGeometry(w + 0.08, 0.06, d * 1.5 + 0.08),
        matFor(0x3a3f4a),
      );
      frame.position.set(cx, c.h * 0.86, cz);
      frame.rotation.x = -0.42;
      scene.add(frame);
    } else if (c.kind === 'barrel') {
      const barrel = new THREE.Mesh(
        new THREE.CylinderGeometry(0.45, 0.45, c.h, 12),
        matFor(KIND_COLORS.barrel),
      );
      barrel.position.set(cx, c.h / 2, cz);
      barrel.castShadow = true;
      barrel.receiveShadow = true;
      scene.add(barrel);
      const lid = new THREE.Mesh(
        new THREE.CylinderGeometry(0.47, 0.47, 0.06, 12),
        matFor(0x5a2e18),
      );
      lid.position.set(cx, c.h - 0.03, cz);
      scene.add(lid);
    } else if (c.kind === 'tank') {
      // Pump machinery: a squat steel tank with a domed cap and a valve pipe.
      const tank = new THREE.Mesh(
        new THREE.CylinderGeometry(1.0, 1.0, c.h, 18),
        new THREE.MeshStandardMaterial({ color: KIND_COLORS.tank, roughness: 0.4, metalness: 0.6 }),
      );
      tank.position.set(cx, c.h / 2, cz);
      tank.castShadow = true;
      tank.receiveShadow = true;
      scene.add(tank);
      const dome = new THREE.Mesh(
        new THREE.SphereGeometry(1.0, 18, 8, 0, Math.PI * 2, 0, Math.PI / 2),
        new THREE.MeshStandardMaterial({ color: 0x55626e, roughness: 0.4, metalness: 0.6 }),
      );
      dome.position.set(cx, c.h, cz);
      scene.add(dome);
      const valve = new THREE.Mesh(
        new THREE.CylinderGeometry(0.09, 0.09, 1.4, 8),
        matFor(0x8a4a2a),
      );
      valve.position.set(cx + 0.9, 1.1, cz);
      valve.rotation.z = Math.PI / 2;
      scene.add(valve);
    } else if (c.kind === 'container') {
      const color = (Math.abs(cx * 7 + cz * 13) % 3 === 0) ? 0x2a7f8f : KIND_COLORS.container;
      const box = new THREE.Mesh(new THREE.BoxGeometry(w, c.h, d), matFor(color));
      box.position.set(cx, c.h / 2, cz);
      box.castShadow = true;
      box.receiveShadow = true;
      scene.add(box);
      const rim = new THREE.Mesh(new THREE.BoxGeometry(w + 0.06, 0.12, d + 0.06), matFor(0x33302c));
      rim.position.set(cx, c.h - 0.06, cz);
      scene.add(rim);
      // Corrugation: two thin vertical ribs so the long faces are not flat.
      for (const off of [-w / 4, w / 4]) {
        const rib = new THREE.Mesh(new THREE.BoxGeometry(0.1, c.h - 0.2, d + 0.04), matFor(0x33302c));
        rib.position.set(cx + off, c.h / 2, cz);
        scene.add(rib);
      }
    } else {
      const box = new THREE.Mesh(new THREE.BoxGeometry(w, c.h, d), matFor(KIND_COLORS[c.kind] || 0x999999));
      box.position.set(cx, c.h / 2, cz);
      box.castShadow = true;
      box.receiveShadow = true;
      scene.add(box);
    }
  }

  // Vent corridor dressing: two service pipes run along the east wall, and a
  // floodlight pole stands at each mouth of the corridor.
  const pipeMat = new THREE.MeshStandardMaterial({ color: 0x7a6a5a, roughness: 0.5, metalness: 0.5 });
  for (const [px, py] of [[12.62, 1.7], [12.62, 2.05]]) {
    const pipe = new THREE.Mesh(new THREE.CylinderGeometry(0.14, 0.14, 22, 10), pipeMat);
    pipe.rotation.x = Math.PI / 2;
    pipe.position.set(px, py, 3);
    pipe.castShadow = true;
    scene.add(pipe);
  }
  const poleMat = matFor(0x4a4a52);
  const lampMat = new THREE.MeshBasicMaterial({ color: 0xffe9b0 });
  for (const [lx, lz, tilt] of [[6.8, 15.2, 0.5], [13.2, -9.2, -0.5]]) {
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.12, 6, 8), poleMat);
    pole.position.set(lx, 3, lz);
    pole.castShadow = true;
    scene.add(pole);
    const head = new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.25, 0.35), lampMat);
    head.position.set(lx, 6.05, lz);
    head.rotation.z = tilt;
    scene.add(head);
    const cone = new THREE.Mesh(
      new THREE.ConeGeometry(3.2, 7, 16, 1, true),
      new THREE.MeshBasicMaterial({
        color: 0xffe9b0, transparent: true, opacity: 0.05,
        blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
      }),
    );
    cone.position.set(lx + tilt * 2.4, 2.6, lz);
    cone.rotation.z = tilt * 1.2;
    scene.add(cone);
  }

  // Site markers: glowing ground rings + floating letters read from the minimap too.
  // Each site keeps its own colour (A teal, B amber) so a callout matches the yard.
  for (const key of Object.keys(SITES)) {
    const s = SITES[key];
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(s.r - 0.25, s.r, 40),
      new THREE.MeshBasicMaterial({ color: s.color, transparent: true, opacity: 0.55, side: THREE.DoubleSide }),
    );
    ring.rotation.x = -Math.PI / 2;
    ring.position.set(s.x, 0.03, s.z);
    scene.add(ring);
    siteRings[key] = ring;
  }
  // Scattered rocks for ground detail (outside the collider list, purely visual).
  const rockMat = matFor(0x7a6a55);
  for (let i = 0; i < 26; i += 1) {
    const rock = new THREE.Mesh(new THREE.BoxGeometry(0.3 + rng() * 0.5, 0.2 + rng() * 0.3, 0.3 + rng() * 0.5), rockMat);
    rock.position.set(-31 + rng() * 62, 0.12, -23 + rng() * 46);
    rock.rotation.y = rng() * Math.PI;
    rock.receiveShadow = true;
    scene.add(rock);
  }

  // --- bots --------------------------------------------------------------------
  const botGroups = [];
  const hitMeshes = [];
  const bodyGeo = new THREE.CapsuleGeometry(0.32, 0.75, 6, 12);
  const headGeo = new THREE.SphereGeometry(0.24, 16, 12);
  const legGeo = new THREE.BoxGeometry(0.16, 0.5, 0.2);
  const gunGeo = new THREE.BoxGeometry(0.09, 0.13, 0.75);
  const visorGeo = new THREE.BoxGeometry(0.3, 0.08, 0.06);
  const darkMat = new THREE.MeshStandardMaterial({ color: 0x1a1a1c, roughness: 0.6 });
  // One bot figure: capsule body, head with a team-coloured visor, gun and legs.
  // The sim moves the group; this only builds it once.
  function buildBotFigure() {
    const g = new THREE.Group();
    const teamMat = new THREE.MeshStandardMaterial({ color: 0x888888, roughness: 0.75 });
    const body = new THREE.Mesh(bodyGeo, teamMat);
    body.position.y = 0.95;
    body.castShadow = true;
    const head = new THREE.Mesh(headGeo, new THREE.MeshStandardMaterial({ color: 0x3a3a42, roughness: 0.6 }));
    head.position.y = 1.78;
    head.castShadow = true;
    const visor = new THREE.Mesh(visorGeo, new THREE.MeshBasicMaterial({ color: 0x2fd4c4 }));
    visor.position.set(0, 1.8, 0.21);
    const gun = new THREE.Mesh(gunGeo, darkMat);
    gun.position.set(0.26, 1.15, 0.35);
    const legL = new THREE.Mesh(legGeo, darkMat);
    legL.position.set(-0.13, 0.25, 0);
    const legR = new THREE.Mesh(legGeo, darkMat);
    legR.position.set(0.13, 0.25, 0);
    g.add(body, head, visor, gun, legL, legR);
    return { group: g, body, head, visor, legL, legR, teamMat, wasAlive: undefined, walkPhase: 0 };
  }
  for (let i = 0; i < 7; i += 1) {
    const view = buildBotFigure();
    view.group.visible = false;
    scene.add(view.group);
    botGroups.push(view);
    hitMeshes.push(view.body, view.head);
  }

  // Death rings: a brief expanding ring where a bot falls (pooled, one per bot).
  const deathRings = [];
  for (let i = 0; i < 7; i += 1) {
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(0.32, 0.5, 24),
      new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0, side: THREE.DoubleSide, depthWrite: false }),
    );
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 0.05;
    ring.visible = false;
    scene.add(ring);
    deathRings.push({ mesh: ring, life: 0 });
  }
  let ringCursor = 0;
  function spawnDeathRing(x, z, color) {
    const r = deathRings[ringCursor];
    ringCursor = (ringCursor + 1) % deathRings.length;
    r.mesh.position.set(x, 0.05, z);
    r.mesh.material.color.setHex(color);
    r.mesh.visible = true;
    r.mesh.scale.setScalar(1);
    r.life = 0.5;
  }

  // --- player viewmodel ---------------------------------------------------------
  const viewmodel = new THREE.Group();
  const vmMat = new THREE.MeshStandardMaterial({ color: 0x232428, roughness: 0.5, metalness: 0.4 });
  const vmBody = new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.15, 0.55), vmMat);
  const vmBarrel = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.025, 0.3, 8), vmMat);
  vmBarrel.rotation.x = Math.PI / 2;
  vmBarrel.position.set(0, 0.02, -0.4);
  const vmSight = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.06, 0.12), vmMat);
  vmSight.position.set(0, 0.11, -0.1);
  const vmGrip = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.16, 0.09), vmMat);
  vmGrip.position.set(0, -0.13, 0.12);
  vmGrip.rotation.x = 0.4;
  viewmodel.add(vmBody, vmBarrel, vmSight, vmGrip);
  viewmodel.position.set(0.3, -0.28, -0.68);
  viewmodel.scale.setScalar(0.75);
  camera.add(viewmodel);
  // Muzzle flash: a radial-gradient sprite at the barrel tip plus a point light
  // that briefly warms the scene, so a shot reads even in the dusk.
  const flashTex = radialTexture(
    'rgba(255, 240, 190, 1)', 'rgba(255, 200, 90, 0.9)', 'rgba(255, 160, 40, 0)',
  );
  const flashMat = new THREE.MeshBasicMaterial({
    map: flashTex, transparent: true, opacity: 0,
    blending: THREE.AdditiveBlending, depthWrite: false,
  });
  const flash = new THREE.Mesh(new THREE.PlaneGeometry(0.24, 0.24), flashMat);
  flash.position.set(0.3, -0.26, -1.05);
  camera.add(flash);
  const flashLight = new THREE.PointLight(0xffc86a, 0, 9, 1.8);
  flashLight.position.set(0.3, -0.2, -1.1);
  camera.add(flashLight);
  let flashLife = 0;
  let recoil = 0;

  // --- tracers (pooled line pairs: bright core + soft glow) ----------------------
  const tracers = [];
  for (let i = 0; i < 24; i += 1) {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(6), 3));
    const coreMat = new THREE.LineBasicMaterial({ color: 0xfff2c0, transparent: true, opacity: 0 });
    const core = new THREE.Line(geo, coreMat);
    core.frustumCulled = false;
    const glowGeo = new THREE.BufferGeometry();
    glowGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(6), 3));
    const glowMat = new THREE.LineBasicMaterial({
      color: 0xff9a3a, transparent: true, opacity: 0,
      blending: THREE.AdditiveBlending, depthWrite: false,
    });
    const glow = new THREE.Line(glowGeo, glowMat);
    glow.frustumCulled = false;
    scene.add(core);
    scene.add(glow);
    tracers.push({ core, glow, geo, glowGeo, life: 0 });
  }
  let tracerCursor = 0;
  function spawnTracer(from, to, color = 0xffd27a) {
    const t = tracers[tracerCursor];
    tracerCursor = (tracerCursor + 1) % tracers.length;
    for (const g of [t.geo, t.glowGeo]) {
      const pos = g.attributes.position.array;
      pos[0] = from.x; pos[1] = from.y; pos[2] = from.z;
      pos[3] = to.x; pos[4] = to.y; pos[5] = to.z;
      g.attributes.position.needsUpdate = true;
    }
    t.core.material.color.setHex(0xfff2c0);
    t.glow.material.color.setHex(color);
    t.core.material.opacity = 0.95;
    t.glow.material.opacity = 0.5;
    t.life = 0.09;
  }

  // --- grenades in flight (pooled spheres with a blinking red lamp) --------------
  const grenadeMeshes = [];
  for (let i = 0; i < 8; i += 1) {
    const g = new THREE.Group();
    const ball = new THREE.Mesh(
      new THREE.SphereGeometry(0.11, 10, 8),
      new THREE.MeshStandardMaterial({ color: 0x2a2d33, roughness: 0.4, metalness: 0.6 }),
    );
    const lamp = new THREE.Mesh(
      new THREE.SphereGeometry(0.045, 8, 6),
      new THREE.MeshBasicMaterial({ color: 0xff2a1a }),
    );
    lamp.position.y = 0.1;
    g.add(ball, lamp);
    g.visible = false;
    scene.add(g);
    grenadeMeshes.push({ group: g, lamp });
  }
  function updateGrenades(list, now) {
    for (let i = 0; i < grenadeMeshes.length; i += 1) {
      const gm = grenadeMeshes[i];
      const g = list[i];
      if (!g) {
        gm.group.visible = false;
        continue;
      }
      gm.group.visible = true;
      gm.group.position.set(g.x, g.y, g.z);
      gm.lamp.material.color.setHex(Math.floor(now * 6) % 2 ? 0xff2a1a : 0x551108);
    }
  }

  // --- smoke clouds (pooled) ----------------------------------------------------
  const smokes = [];
  const smokeGeo = new THREE.SphereGeometry(2.2, 12, 10);
  for (let i = 0; i < 6; i += 1) {
    const g = new THREE.Group();
    const m = new THREE.MeshBasicMaterial({ color: 0x9a9a9a, transparent: true, opacity: 0, depthWrite: false });
    for (let j = 0; j < 3; j += 1) {
      const s = new THREE.Mesh(smokeGeo, m);
      s.position.set((j - 1) * 1.4, 0.8 + j * 0.5, (j % 2 ? 1 : -1) * 0.9);
      g.add(s);
    }
    g.visible = false;
    scene.add(g);
    smokes.push({ group: g, mat: m, life: 0, maxLife: CFG.smokeTime });
  }
  let smokeCursor = 0;
  function addSmoke(x, z) {
    const s = smokes[smokeCursor];
    smokeCursor = (smokeCursor + 1) % smokes.length;
    s.group.position.set(x, 0, z);
    s.group.visible = true;
    s.group.scale.setScalar(0.4);
    s.life = s.maxLife;
  }

  // --- spike ---------------------------------------------------------------------
  const spikeGroup = new THREE.Group();
  const spikeBox = new THREE.Mesh(
    new THREE.BoxGeometry(0.34, 0.2, 0.34),
    new THREE.MeshStandardMaterial({ color: 0x222226, roughness: 0.5, metalness: 0.5 }),
  );
  spikeBox.position.y = 0.1;
  const spikeLight = new THREE.Mesh(
    new THREE.SphereGeometry(0.09, 10, 8),
    new THREE.MeshBasicMaterial({ color: 0xff2a1a }),
  );
  spikeLight.position.y = 0.26;
  spikeGroup.add(spikeBox, spikeLight);
  spikeGroup.visible = false;
  scene.add(spikeGroup);

  const mm = minimapCanvas ? minimapCanvas.getContext('2d') : null;
  let slowmo = false;
  // Aim-down-sights: 0 is hipfire, 1 is fully aimed. The target comes from the
  // sim each frame (main.js); updateFx eases toward it so the zoom is smooth.
  let adsTarget = 0;
  let adsF = 0;

  return {
    renderer, scene, camera, hitMeshes,
    dom: renderer.domElement,
    resize() {
      camera.aspect = window.innerWidth / window.innerHeight;
      camera.updateProjectionMatrix();
      renderer.setSize(window.innerWidth, window.innerHeight);
    },
    setCamera(x, y, z, yaw, pitch) {
      camera.position.set(x, y, z);
      camera.rotation.set(pitch, yaw, 0, 'YXZ');
    },
    updateBots(bots, dt = 1 / 60) {
      for (let i = 0; i < bots.length; i += 1) {
        const bot = bots[i];
        const view = botGroups[i];
        view.group.visible = true;
        // Walk cycle: the legs swing with distance travelled and the body bobs
        // a touch, so a moving bot reads as walking instead of gliding. Only
        // the moving states swing — a planting, defusing or holding bot stands.
        const movingState = bot.state === 'route' || bot.state === 'rotate'
          || bot.state === 'engage' || bot.state === 'retreat' || bot.state === 'peek';
        const speed = movingState ? Math.hypot(bot.vx || 0, bot.vz || 0) : 0;
        view.walkPhase += speed * dt * 2.4;
        const swing = Math.sin(view.walkPhase) * 0.55;
        view.legL.rotation.x = swing;
        view.legR.rotation.x = -swing;
        view.group.position.set(bot.x, bot.alive ? Math.abs(Math.sin(view.walkPhase)) * 0.04 : 0.35, bot.z);
        view.group.rotation.set(bot.alive ? 0 : -Math.PI / 2 + 0.12, bot.yaw, 0);
        const color = TEAMS[bot.team].color;
        view.teamMat.color.setHex(color);
        view.visor.material.color.setHex(color);
        view.body.userData.bot = bot;
        view.body.userData.part = 'body';
        view.head.userData.bot = bot;
        view.head.userData.part = 'head';
        // A bot that just fell leaves a brief expanding ring on the sand.
        if (view.wasAlive === true && !bot.alive) spawnDeathRing(bot.x, bot.z, color);
        view.wasAlive = bot.alive;
      }
    },
    muzzleFlash(kick) {
      flashMat.opacity = 0.95;
      flashLife = 0.05;
      flashLight.intensity = 14;
      recoil = Math.min(0.09, recoil + kick);
    },
    setSlowmo(on) { slowmo = on; },
    setAdsTarget(f) { adsTarget = f ? 1 : 0; },
    updateFx(dt, now) {
      // Round-end slow motion: effects decay at a third of their pace.
      const fdt = slowmo ? dt * 0.35 : dt;
      // Aim-down-sights: ease the field of view in and pull the viewmodel (and
      // the muzzle flash with it) to the centre of the screen, so aiming feels
      // like raising the gun instead of a snap. Recoil still pushes the gun back.
      if (adsF !== adsTarget) {
        const step = fdt * 9;
        adsF += Math.abs(adsTarget - adsF) <= step ? adsTarget - adsF : Math.sign(adsTarget - adsF) * step;
        camera.fov = 74 - (74 - CFG.adsFov) * adsF;
        camera.updateProjectionMatrix();
      }
      viewmodel.position.set(
        0.3 * (1 - adsF),
        -0.28 + 0.095 * adsF,
        -0.68 + 0.13 * adsF + recoil,
      );
      flash.position.set(0.3 * (1 - adsF), -0.26 + 0.095 * adsF, -1.05);
      flashLight.position.set(0.3 * (1 - adsF), -0.2 + 0.05 * adsF, -1.1);
      if (flashLife > 0) {
        flashLife -= fdt;
        if (flashLife <= 0) {
          flashMat.opacity = 0;
          flashLight.intensity = 0;
        } else {
          flashLight.intensity = Math.max(0, flashLight.intensity - fdt * 220);
        }
      }
      if (recoil > 0) {
        recoil = Math.max(0, recoil - fdt * 0.35);
      }
      for (const t of tracers) {
        if (t.life > 0) {
          t.life -= fdt;
          const k = Math.max(0, t.life / 0.09);
          t.core.material.opacity = k * 0.95;
          t.glow.material.opacity = k * 0.5;
        }
      }
      for (const s of smokes) {
        if (s.life > 0) {
          s.life -= fdt;
          const grown = Math.min(1, (s.maxLife - s.life) / 0.8 + 0.4);
          s.group.scale.setScalar(Math.min(1.15, grown));
          s.mat.opacity = s.life < 2 ? 0.32 * (s.life / 2) : 0.32;
          if (s.life <= 0) s.group.visible = false;
        }
      }
      for (const cloud of clouds) {
        cloud.position.x += cloud.userData.speed * fdt;
        if (cloud.position.x > 95) cloud.position.x = -95;
      }
      for (const r of deathRings) {
        if (r.life > 0) {
          r.life -= fdt;
          const k = Math.max(0, r.life / 0.5);
          r.mesh.scale.setScalar(1 + (1 - k) * 2.5);
          r.mesh.material.opacity = k * 0.7;
          if (r.life <= 0) r.mesh.visible = false;
        }
      }
      if (spikeGroup.visible) {
        spikeLight.material.color.setHex(Math.floor(now * 2) % 2 ? 0xff2a1a : 0x881108);
      }
    },
    spawnTracer,
    addSmoke,
    updateGrenades,
    setSpike(x, z, on) {
      spikeGroup.visible = on;
      if (on) spikeGroup.position.set(x, 0, z);
    },
    render() {
      renderer.render(scene, camera);
    },
    drawMinimap(state) {
      if (!mm) return;
      const W = minimapCanvas.width;
      const H = minimapCanvas.height;
      const sx = W / CFG.mapW;
      const sz = H / CFG.mapD;
      const px = (x) => (x + CFG.mapW / 2) * sx;
      const pz = (z) => (z + CFG.mapD / 2) * sz;
      mm.fillStyle = '#141a2a';
      mm.fillRect(0, 0, W, H);
      mm.fillStyle = '#3a4152';
      for (const c of COLLIDERS) {
        mm.fillRect(px(c.x0), pz(c.z0), (c.x1 - c.x0) * sx, (c.z1 - c.z0) * sz);
      }
      for (const key of Object.keys(SITES)) {
        const s = SITES[key];
        mm.strokeStyle = s.css;
        mm.lineWidth = 1.5;
        mm.beginPath();
        mm.arc(px(s.x), pz(s.z), s.r * sx, 0, Math.PI * 2);
        mm.stroke();
        mm.fillStyle = s.css;
        mm.font = 'bold 10px sans-serif';
        mm.fillText(key, px(s.x) - 3, pz(s.z) + 3);
      }
      if (state.spike.planted) {
        mm.fillStyle = Math.floor(performance.now() / 300) % 2 ? '#ff2a1a' : '#881108';
        mm.beginPath();
        mm.arc(px(state.spike.x), pz(state.spike.z), 4, 0, Math.PI * 2);
        mm.fill();
      }
      for (const b of state.bots) {
        if (!b.alive) continue;
        mm.fillStyle = b.isAlly ? '#2fd4c4' : '#e86a2c';
        mm.beginPath();
        mm.arc(px(b.x), pz(b.z), b.isAlly ? 3 : 2.5, 0, Math.PI * 2);
        mm.fill();
      }
      // Player: white triangle pointing where they face (menu has no player yet).
      const p = state.player;
      if (!p) return;
      mm.fillStyle = '#ffffff';
      mm.save();
      mm.translate(px(p.x), pz(p.z));
      mm.rotate(Math.atan2(-Math.sin(p.yaw), -Math.cos(p.yaw)) + Math.PI / 2);
      mm.beginPath();
      mm.moveTo(0, -5);
      mm.lineTo(3.5, 4);
      mm.lineTo(-3.5, 4);
      mm.closePath();
      mm.fill();
      mm.restore();
    },
  };
}
