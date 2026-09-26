<template>
  <div>
    <p class="mt-hint mb-3">
      Analyze links from this transmitter to one or more receivers (all use the
      Receiver settings above): terrain profile, line of sight, Fresnel
      clearance, and link margin.
    </p>

    <div class="flex gap-2">
      <button
        type="button"
        class="mt-btn mt-btn-sm flex-1"
        :class="store.linkState === 'placing' ? 'mt-btn-secondary' : 'mt-btn-primary'"
        @click="store.beginPlaceTarget()"
      >
        {{ store.linkState === 'placing' ? 'Click the map…' : 'Add receiver' }}
      </button>
      <button v-if="store.receivers.length" type="button" class="mt-btn mt-btn-secondary mt-btn-sm" @click="store.clearLink()">
        Clear all
      </button>
    </div>

    <ul v-if="store.receivers.length" class="mt-2 flex flex-col gap-1">
      <li
        v-for="(r, i) in store.receivers"
        :key="i"
        class="flex cursor-pointer items-center gap-2 rounded-lg border px-2 py-1 text-sm"
        :class="i === store.selectedRx ? 'border-primary bg-surface-2' : 'border-line'"
        @click="store.selectedRx = i"
      >
        <span class="size-2.5 shrink-0 rounded-full" :style="{ background: linkColor(r.analysis) }" aria-hidden="true"></span>
        <span class="font-semibold">#{{ i + 1 }}</span>
        <span class="flex-1 text-ink-muted tabular-nums">
          <template v-if="r.analysis">
            {{ fmt(r.analysis.distanceKm, 1) }} km · {{ fmt(r.analysis.rxDbm, 1) }} dBm ·
            {{ r.analysis.marginDb >= 0 ? '+' : '' }}{{ fmt(r.analysis.marginDb, 1) }} dB
          </template>
          <template v-else>computing…</template>
        </span>
        <button type="button" class="px-1 text-ink-muted hover:text-ink" :aria-label="`Remove receiver ${i + 1}`" @click.stop="store.removeReceiver(i)">×</button>
      </li>
    </ul>

    <div v-if="sel" class="mt-2 grid grid-cols-2 gap-2">
      <div>
        <label for="tgt_lat" class="mt-label">Receiver #{{ store.selectedRx + 1 }} lat</label>
        <input id="tgt_lat" v-model.number="tLat" @change="applyCoords" type="number" step="0.000001" min="-90" max="90" class="mt-input" />
      </div>
      <div>
        <label for="tgt_lon" class="mt-label">Receiver #{{ store.selectedRx + 1 }} lon</label>
        <input id="tgt_lon" v-model.number="tLon" @change="applyCoords" type="number" step="0.000001" min="-180" max="180" class="mt-input" />
      </div>
    </div>

    <p v-if="!store.receivers.length && store.linkState !== 'placing'" class="mt-hint mt-2">
      Tip: drag a blue receiver pin to move it, click it to show its details; links recompute automatically.
    </p>

    <div v-if="store.linkState === 'computing'" class="mt-3 flex items-center gap-2 text-sm text-ink-muted">
      <span class="mt-spinner" role="status" aria-hidden="true"></span>
      Computing link…
    </div>

    <div v-if="store.linkState === 'error'" class="mt-3 rounded-lg border border-danger bg-danger-bg p-2 text-sm text-on-danger-bg" role="alert">
      {{ store.linkError }}
    </div>

    <div v-if="a && store.linkState !== 'computing'" class="mt-3">
      <div class="mt-link-verdict" :class="verdictClass">
        <span class="mt-link-verdict-dot" aria-hidden="true"></span>{{ verdictText }}
      </div>

      <dl class="mt-link-stats mt-2">
        <div><dt>Distance</dt><dd>{{ fmt(a.distanceKm, 2) }} km</dd></div>
        <div><dt>Received</dt><dd>{{ fmt(a.rxDbm, 1) }} dBm</dd></div>
        <div><dt>Margin</dt><dd :class="a.marginDb >= 0 ? 'mt-pos' : 'mt-neg'">{{ a.marginDb >= 0 ? '+' : '' }}{{ fmt(a.marginDb, 1) }} dB</dd></div>
        <div><dt>Line of sight</dt><dd :class="a.losClear ? 'mt-pos' : 'mt-neg'">{{ a.losClear ? 'Clear' : 'Blocked' }}</dd></div>
        <div><dt>Fresnel</dt><dd :class="a.fresnelClear ? 'mt-pos' : 'mt-neg'">{{ fmt(a.fresnelClearanceFraction * 100, 0) }}% clear</dd></div>
      </dl>

      <svg v-if="chart" class="mt-link-chart mt-2" :viewBox="`0 0 ${chart.W} ${chart.H}`" preserveAspectRatio="none"
        role="img" aria-label="Terrain profile with line of sight and Fresnel zone">
        <polygon :points="chart.terrainArea" fill="#3a4150" stroke="none" />
        <polyline :points="chart.terrain" fill="none" stroke="#8a93a6" stroke-width="1" />
        <polyline :points="chart.fresnel" fill="none" :stroke="rayColor" stroke-width="1" stroke-dasharray="3 2" opacity="0.7" />
        <polyline :points="chart.ray" fill="none" :stroke="rayColor" stroke-width="1.5" />
      </svg>
      <div v-if="chart" class="mt-link-axis">
        <span>TX</span>
        <span>{{ fmt(a.distanceKm, 1) }} km · {{ fmt(sel!.azimuthDeg, 0) }}°</span>
        <span>RX #{{ store.selectedRx + 1 }}</span>
      </div>

      <button type="button" class="mt-btn mt-btn-secondary mt-btn-sm mt-2 w-full" @click="store.computeLink()">
        Recompute all with current settings
      </button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch } from 'vue';
import { useStore } from '../store.ts';
import { linkColor } from '../engine/link.ts';

const store = useStore();
const sel = computed(() => store.receivers[store.selectedRx]);
const a = computed(() => sel.value?.analysis ?? null);

const tLat = ref<number | null>(null);
const tLon = ref<number | null>(null);
watch(
  () => sel.value && { lat: sel.value.lat, lon: sel.value.lon },
  (t) => {
    tLat.value = t?.lat ?? null;
    tLon.value = t?.lon ?? null;
  },
  { immediate: true, deep: true }
);

function applyCoords() {
  if (tLat.value == null || tLon.value == null) return;
  const lat = Number(tLat.value);
  const lon = Number(tLon.value);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return;
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return;
  store.moveReceiver(store.selectedRx, lat, lon);
}

const fmt = (n: number, d: number) => (Number.isFinite(n) ? n.toFixed(d) : '–');

const rayColor = computed(() => linkColor(a.value));

const verdictClass = computed(() => {
  const l = a.value;
  if (!l) return '';
  if (l.marginDb >= 0 && l.losClear && l.fresnelClear) return 'mt-verdict-good';
  if (l.marginDb >= 0 && l.losClear) return 'mt-verdict-marginal';
  return 'mt-verdict-bad';
});

const verdictText = computed(() => {
  const l = a.value;
  if (!l) return '';
  if (l.marginDb < 0) return 'Link unlikely (below sensitivity)';
  if (!l.losClear) return 'Link blocked (no line of sight)';
  if (!l.fresnelClear) return 'Link marginal (Fresnel obstructed)';
  return 'Link looks viable';
});

/* Profile chart geometry: terrain (curvature-adjusted), the line-of-sight ray,
   and the bottom of the first Fresnel zone, scaled into a fixed viewBox. */
const chart = computed(() => {
  const l = a.value;
  if (!l || l.samples.length < 2) return null;
  const W = 320;
  const H = 120;
  const padX = 3;
  const padY = 6;
  const iw = W - 2 * padX;
  const ih = H - 2 * padY;
  const s = l.samples;
  const xMax = l.distanceKm || 1;
  let yMin = Infinity;
  let yMax = -Infinity;
  for (const p of s) {
    yMin = Math.min(yMin, p.curvedGroundM, p.rayM, p.fresnelBottomM);
    yMax = Math.max(yMax, p.curvedGroundM, p.rayM, p.fresnelBottomM);
  }
  if (yMin === yMax) {
    yMin -= 1;
    yMax += 1;
  }
  const yPad = (yMax - yMin) * 0.08;
  yMin -= yPad;
  yMax += yPad;
  const X = (d: number) => padX + (d / xMax) * iw;
  const Y = (e: number) => padY + (1 - (e - yMin) / (yMax - yMin)) * ih;
  const pts = (sel: (p: (typeof s)[number]) => number) =>
    s.map((p) => `${X(p.distanceKm).toFixed(1)},${Y(sel(p)).toFixed(1)}`).join(' ');
  const terrain = pts((p) => p.curvedGroundM);
  return {
    W,
    H,
    terrain,
    terrainArea: `${padX},${(H - padY).toFixed(1)} ${terrain} ${(W - padX).toFixed(1)},${(H - padY).toFixed(1)}`,
    fresnel: pts((p) => p.fresnelBottomM),
    ray: `${X(s[0].distanceKm)},${Y(s[0].rayM)} ${X(s[s.length - 1].distanceKm)},${Y(s[s.length - 1].rayM)}`,
  };
});
</script>
