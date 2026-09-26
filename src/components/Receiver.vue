<template>
  <div>
    <p class="mt-hint mb-3">
      The nodes that should hear this site. Antenna gain affects point-to-point
      links only, not the coverage map.
    </p>
    <div class="grid grid-cols-2 gap-2">
      <div class="col-span-2">
        <label for="rx_device" class="mt-label">Device (optional)</label>
        <select v-model="selectedDevice" @change="apply" class="mt-select" id="rx_device" title="Fill antenna gain (and, with a modem, sensitivity) from a device.">
          <option value="">Custom / manual</option>
          <option v-for="(d, i) in DEVICE_PROFILES" :key="i" :value="i">{{ d.label }}</option>
        </select>
      </div>
      <div class="col-span-2">
        <label for="rx_modem" class="mt-label">Modem (spreading factor / bandwidth)</label>
        <select v-model="selectedModem" @change="apply" class="mt-select" id="rx_modem" title="Sets sensitivity from the device's datasheet.">
          <option value="">Custom</option>
          <optgroup v-for="g in ['Meshtastic', 'LoRa'] as const" :key="g" :label="g === 'LoRa' ? 'LoRa SF / BW' : 'Meshtastic presets'">
            <template v-for="(m, i) in MODEMS" :key="i">
              <option v-if="m.group === g" :value="i">{{ m.label }}</option>
            </template>
          </optgroup>
        </select>
        <p v-if="source" class="mt-hint mt-1">{{ source }}</p>
      </div>
      <div>
        <label for="rx_sensitivity" class="mt-label">Sensitivity (dBm)</label>
        <input v-model="receiver.rx_sensitivity" type="number" class="mt-input" id="rx_sensitivity" step="1" min="-150" max="-30" />
      </div>
      <div>
        <label for="rx_height" class="mt-label">Height AGL (m)</label>
        <input v-model="receiver.rx_height" type="number" class="mt-input" id="rx_height" min="0" step="0.1" />
      </div>
      <div>
        <label for="rx_gain" class="mt-label">Antenna Gain (dBi)</label>
        <input v-model="receiver.rx_gain" type="number" class="mt-input" id="rx_gain" min="0" max="30" step="0.1" />
      </div>
      <div>
        <label for="rx_loss" class="mt-label">Cable Loss (dB)</label>
        <input v-model="receiver.rx_loss" type="number" class="mt-input" id="rx_loss" min="0" max="100" step="0.1" />
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useStore } from '../store.ts';
import { DEVICE_PROFILES } from '../deviceProfiles.ts';
import { MODEMS, sensitivityDbm } from '../sensitivity.ts';

const receiver = useStore().splatParams.receiver;

const selectedDevice = ref<number | ''>('');
const selectedModem = ref<number | ''>(MODEMS.findIndex((m) => m.label.startsWith('LONG_FAST')));
const device = computed(() => (selectedDevice.value === '' ? undefined : DEVICE_PROFILES[selectedDevice.value]));
const modem = computed(() => (selectedModem.value === '' ? undefined : MODEMS[selectedModem.value]));

/** Datasheet sensitivity for the selected device + modem, if we have its table. */
const derived = computed(() =>
  device.value?.chip && modem.value ? sensitivityDbm(device.value.chip, modem.value.sf, modem.value.bwKHz) : undefined
);

function apply() {
  if (device.value) receiver.rx_gain = device.value.tx_gain; // same antenna + pigtail
  if (derived.value) receiver.rx_sensitivity = Math.round(derived.value.dbm);
}

const source = computed(() => {
  if (!device.value || !modem.value) return '';
  if (!device.value.chip) return 'No sensitivity table for this device: set sensitivity manually.';
  const d = derived.value!;
  const chip = device.value.chip === 'lsm100a' ? 'LSM100A' : 'SX1262';
  return `${Math.round(d.dbm)} dBm from the ${chip} datasheet, SF${modem.value.sf} / ${modem.value.bwKHz} kHz${d.estimate ? ' (estimate)' : ''}.`;
});

// Hand-edits away from a filled value fall back to "Custom", as in the
// transmitter form, so the dropdowns never misrepresent the fields.
watch(
  () => Number(receiver.rx_gain),
  (g) => {
    if (device.value && g !== device.value.tx_gain) selectedDevice.value = '';
  }
);
watch(
  () => Number(receiver.rx_sensitivity),
  (s) => {
    if (derived.value && s !== Math.round(derived.value.dbm)) selectedModem.value = '';
  }
);
</script>
