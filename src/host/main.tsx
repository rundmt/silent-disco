import { render } from 'solid-js/web';
import { HostApp } from './App';
import '../shared/style.css';

render(() => <HostApp />, document.getElementById('root')!);
