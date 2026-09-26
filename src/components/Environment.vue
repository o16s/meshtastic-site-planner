<template>
  <div>
    <p class="mt-hint mb-3">Terrain and atmosphere assumptions; the defaults suit most deployments.</p>
    <div class="grid grid-cols-2 gap-2">
      <div>
        <label for="radio_climate" class="mt-label">Radio Climate</label>
        <select v-model="environment.radio_climate" id="radio_climate" class="mt-select">
          <option value="equatorial">Equatorial</option>
          <option value="continental_subtropical">Continental Subtropical</option>
          <option value="maritime_subtropical">Maritime Subtropical</option>
          <option value="desert">Desert</option>
          <option value="continental_temperate">Continental Temperate</option>
          <option value="maritime_temperate_land">Maritime Temperate (Land)</option>
          <option value="maritime_temperate_sea">Maritime Temperate (Sea)</option>
        </select>
      </div>
      <div>
        <label for="polarization" class="mt-label">Polarization</label>
        <select v-model="environment.polarization" id="polarization" class="mt-select">
          <option value="horizontal">Horizontal</option>
          <option value="vertical">Vertical</option>
        </select>
      </div>
      <div class="col-span-2">
        <label for="clutter_source" class="mt-label">Clutter (trees, buildings)</label>
        <select v-model="environment.clutter_source" id="clutter_source" class="mt-select">
          <option value="uniform">Uniform height everywhere (classic)</option>
          <option value="landcover">From land cover map (10 m)</option>
        </select>
        <p v-if="environment.clutter_source === 'landcover'" class="mt-hint mt-1">
          Trees get the tree height, bare ground/lava and water none, fields ~1 m, built-up 8 m.
          Elevation data already includes part of a dense canopy, so use less than the full tree height.
          {{ LANDCOVER_ATTRIBUTION }}.
        </p>
      </div>
      <div v-if="environment.clutter_source === 'landcover'">
        <label for="tree_height" class="mt-label">Tree height (m)</label>
        <input v-model.number="environment.tree_height" type="number" class="mt-input" id="tree_height" min="0" max="60" step="1" />
      </div>
      <div>
        <label for="clutter_height" class="mt-label">
          {{ environment.clutter_source === 'landcover' ? 'Clutter where unknown (m)' : 'Clutter Height (m)' }}
        </label>
        <input v-model="environment.clutter_height" type="number" class="mt-input" id="clutter_height" min="0" step="0.1" />
      </div>
      <div>
        <label for="ground_dielectric" class="mt-label">Ground Dielectric Constant</label>
        <input v-model="environment.ground_dielectric" type="number" class="mt-input" id="ground_dielectric" min="1" step="0.1" />
      </div>
      <div>
        <label for="ground_conductivity" class="mt-label">Ground Conductivity (S/m)</label>
        <input v-model="environment.ground_conductivity" type="number" class="mt-input" id="ground_conductivity" min="0" step="0.001" />
      </div>
      <div>
        <label for="atmosphere_bending" class="mt-label">Atmospheric Bending (N-units)</label>
        <input v-model="environment.atmosphere_bending" type="number" class="mt-input" id="atmosphere_bending" min="0" step="0.1" />
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { watch } from 'vue';
import { useStore } from '../store.ts';
import { LANDCOVER_ATTRIBUTION } from '../terrain/landcover.ts';
const store = useStore();
const environment = store.splatParams.environment;
watch(() => environment.clutter_source, () => store.syncLandCoverCredit());
</script>
