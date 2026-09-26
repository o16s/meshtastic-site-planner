<template>
  <div>
    <p class="mt-hint mb-3">
      Lay an image (site plan, scanned map, drawing) over the map. Drag a corner
      to scale it (ratio stays locked), the center dot to move it, the dot above
      the top edge to rotate it.
    </p>

    <div class="flex gap-2">
      <button type="button" class="mt-btn mt-btn-primary mt-btn-sm flex-1" @click="fileInput?.click()">
        {{ store.canvasName ? 'Replace image…' : 'Import image…' }}
      </button>
      <input ref="fileInput" type="file" accept="image/png,image/jpeg" class="hidden" @change="onImport" />
      <button v-if="store.canvasName" type="button" class="mt-btn mt-btn-secondary mt-btn-sm" @click="store.removeCanvas()">
        Remove
      </button>
    </div>

    <div v-if="error" class="mt-2 rounded-lg border border-danger bg-danger-bg p-2 text-sm text-on-danger-bg" role="alert">
      {{ error }}
    </div>

    <template v-if="store.canvasName">
      <p class="mt-hint mt-2 truncate" :title="store.canvasName">{{ store.canvasName }}</p>
      <label for="canvas_opacity" class="mt-label mt-2">Opacity: {{ store.canvasOpacity }}%</label>
      <input
        id="canvas_opacity"
        type="range"
        min="0"
        max="100"
        step="1"
        class="w-full accent-[var(--mt-primary)]"
        :value="store.canvasOpacity"
        @input="store.setCanvasOpacity(Number(($event.target as HTMLInputElement).value))"
      />
      <label class="mt-2 flex cursor-pointer items-center gap-2 text-sm text-ink">
        <input
          type="checkbox"
          class="accent-[var(--mt-primary)]"
          :checked="store.canvasLocked"
          @change="store.setCanvasLocked(($event.target as HTMLInputElement).checked)"
        />
        Lock position (hide handles)
      </label>
    </template>
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue';
import { useStore } from '../store.ts';

const store = useStore();
const fileInput = ref<HTMLInputElement | null>(null);
const error = ref('');

async function onImport(e: Event) {
  const input = e.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = ''; // allow re-importing the same file
  if (!file) return;
  error.value = '';
  try {
    await store.importCanvas(file);
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  }
}
</script>
