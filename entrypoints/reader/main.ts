import { mount } from 'svelte';
import '../../src/studio-theme.css';
import Reader from '../../src/Reader.svelte';
mount(Reader, { target: document.getElementById('app')! });
