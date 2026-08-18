import { mount } from 'svelte';
import App from './App.svelte';
import './app.css';

const el = document.getElementById('app');
if (el === null) throw new Error('#app 이 없다');
mount(App, { target: el });
