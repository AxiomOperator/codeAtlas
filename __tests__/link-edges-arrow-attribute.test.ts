/**
 * R-RES6: a link tag whose EARLIER attribute holds an arrow — `<Link
 * onClick={() => track()} href="/users">` — still navigates. The arrow's `>`
 * is not the tag's end; every router's link synthesizer reads through it
 * (one shared tag pattern, `link-edges.ts`).
 */
import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';
import { initGrammars, loadAllGrammars } from '../src/extraction/grammars';

let dir: string;
function write(rel: string, content: string): void {
  const full = path.join(dir, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
}

async function navigatesFrom(component: string): Promise<Array<{ href: unknown; by: unknown }>> {
  const cg = CodeGraph.initSync(dir);
  try {
    await cg.indexAll();
    const from = cg.getNodesByName(component).find((n) => n.kind === 'function' || n.kind === 'component');
    if (!from) throw new Error(`no ${component}`);
    return cg
      .getOutgoingEdges(from.id)
      .filter((e) => e.kind === 'navigates')
      .map((e) => {
        const meta = e.metadata as Record<string, unknown>;
        return { href: meta.href, by: meta.synthesizedBy };
      });
  } finally {
    cg.close();
  }
}

beforeAll(async () => {
  await initGrammars();
  await loadAllGrammars();
});

afterEach(() => {
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
});

describe('link synthesizers read through an arrow-valued attribute (R-RES6)', () => {
  it('Next.js <Link onClick={() => …} href>', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-link-next-'));
    write('package.json', JSON.stringify({ name: 'site', dependencies: { next: '15', react: '19' } }));
    write(
      'app/page.tsx',
      "import Link from 'next/link'\n" +
        'export default function Home() {\n' +
        '  return <Link onClick={() => track()} href="/users">Users</Link>\n' +
        '}\n'
    );
    write('app/users/page.tsx', 'export default function Users() {\n  return <div />\n}\n');
    expect(await navigatesFrom('Home')).toEqual([{ href: '/users', by: 'next-link' }]);
  });

  it('TanStack Router <Link onClick={() => …} to>', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-link-tanstack-'));
    write('package.json', JSON.stringify({ name: 'app', dependencies: { react: '19', '@tanstack/react-router': '1' } }));
    write(
      'src/routes/index.tsx',
      "import { createFileRoute, Link } from '@tanstack/react-router'\n" +
        "export const Route = createFileRoute('/')({ component: IndexComponent })\n" +
        'function IndexComponent() {\n' +
        '  return <Link onClick={() => track()} to="/login">Sign in</Link>\n' +
        '}\n'
    );
    write(
      'src/routes/login.tsx',
      "import { createFileRoute } from '@tanstack/react-router'\n" +
        "export const Route = createFileRoute('/login')({ component: LoginComponent })\n" +
        'function LoginComponent() {\n  return <div />\n}\n'
    );
    expect(await navigatesFrom('IndexComponent')).toEqual([{ href: '/login', by: 'tanstack-link' }]);
  });

  it('React Router <Link onClick={() => …} to>', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-link-react-'));
    write('package.json', JSON.stringify({ name: 'shop', dependencies: { react: '18', 'react-router-dom': '5' } }));
    write(
      'src/App.js',
      "import { BrowserRouter as Router, Route } from 'react-router-dom'\n" +
        "import HomeScreen from './screens/HomeScreen'\n" +
        "import LoginScreen from './screens/LoginScreen'\n" +
        'const App = () => (\n' +
        '  <Router>\n' +
        "    <Route path='/' component={HomeScreen} exact />\n" +
        "    <Route path='/login' component={LoginScreen} />\n" +
        '  </Router>\n' +
        ')\n' +
        'export default App\n'
    );
    write(
      'src/screens/HomeScreen.js',
      "import { Link } from 'react-router-dom'\n" +
        'const HomeScreen = () => {\n' +
        '  return <Link onClick={() => track()} to="/login">Sign in</Link>\n' +
        '}\n' +
        'export default HomeScreen\n'
    );
    write('src/screens/LoginScreen.js', 'const LoginScreen = () => <div />\nexport default LoginScreen\n');
    expect(await navigatesFrom('HomeScreen')).toEqual([{ href: '/login', by: 'react-router-link' }]);
  });

  it('SvelteKit <a on:click={() => …} href>', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-link-svelte-'));
    write('package.json', JSON.stringify({ name: 'site', devDependencies: { '@sveltejs/kit': '2', svelte: '5' } }));
    write('src/routes/+page.svelte', '<script>\n  export let data\n</script>\n<a on:click={() => track()} href="/login">Sign in</a>\n');
    write('src/routes/login/+page.svelte', '<script>\n  export let form\n</script>\n<h1>Login</h1>\n');
    const cg = CodeGraph.initSync(dir);
    try {
      await cg.indexAll();
      const navs = cg
        .getNodesInFile('src/routes/+page.svelte')
        .flatMap((n) => cg.getOutgoingEdges(n.id))
        .filter((e) => e.kind === 'navigates')
        .map((e) => (e.metadata as Record<string, unknown>).href);
      expect(navs).toEqual(['/login']);
    } finally {
      cg.close();
    }
  });

  it('Vue Router <router-link @click="() => …" :to>', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-link-vue-'));
    write('package.json', JSON.stringify({ name: 'app', dependencies: { vue: '3', 'vue-router': '4' } }));
    write(
      'src/router/index.js',
      'import { createRouter, createWebHistory } from "vue-router"\n' +
        'const router = createRouter({\n' +
        '  history: createWebHistory(),\n' +
        '  routes: [\n' +
        '    { name: "home", path: "/", component: () => import("@/views/Home") },\n' +
        '    { name: "login", path: "/login", component: () => import("@/views/Login") }\n' +
        '  ]\n' +
        '})\n' +
        'export default router\n'
    );
    write(
      'src/views/Home.vue',
      '<template>\n' +
        '  <router-link @click="() => track()" :to="{ name: \'login\' }">Sign in</router-link>\n' +
        '</template>\n' +
        '<script setup>\nfunction track() { return 1 }\n</script>\n'
    );
    write('src/views/Login.vue', '<template><div /></template>\n<script setup>\n</script>\n');
    expect(await navigatesFrom('Home')).toEqual([{ href: 'login', by: 'vue-router-link' }]);
  });
});
