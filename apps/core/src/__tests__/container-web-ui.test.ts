import { createServer, type Server, type RequestListener } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Container } from '@talome/types';
import { browserPageTitle, createWebUiDiscovery, probeWebUi, webUiCandidates } from '../docker/web-ui.js';
const container = (extra: Partial<Container> = {}): Container => ({ id: 'abc123', name: 'app', image: 'example:latest', status: 'running', ports: [{host: 3000, container: 3000, protocol: 'tcp'}], labels: {}, created: '', ...extra });
const servers: Server[] = [];
afterEach(async () => { await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }))); });
async function server(handler: RequestListener) {
 const instance = createServer(handler); servers.push(instance);
 await new Promise<void>(resolve => instance.listen(0, '127.0.0.1', resolve));
 return (instance.address() as {port:number}).port;
}
describe('browser UI discovery', () => {
 it('does not turn database, discovery or UDP ports into apps', () => {
  expect(webUiCandidates(container({ports: [{host:54322,container:5432,protocol:'tcp'},{host:5353,container:5353,protocol:'udp'}]}))).toEqual([]);
 });
 it('recognizes a host-network Home Assistant candidate and honors opt out', () => {
  expect(webUiCandidates(container({image:'homeassistant/home-assistant:latest',networkMode:'host',ports:[]}))[0]?.port).toBe(8123);
  expect(webUiCandidates(container({labels:{'talome.ui.enabled':'false'}}))).toEqual([]);
 });
 it('supports explicit published UI port/path/name but never arbitrary hosts or unmapped ports', () => {
  expect(webUiCandidates(container({ports:[{host:18888,container:8888,protocol:'tcp'}],labels:{'talome.ui.port':'8888','talome.ui.path':'/admin','talome.ui.name':'My App'}}))[0]).toMatchObject({port:18888,path:'/admin',title:'My App',source:'configured'});
  expect(webUiCandidates(container({labels:{'talome.ui.port':'9999'}}))).toEqual([]);
  expect(webUiCandidates(container({labels:{'talome.ui.path':'//example.com'}}))).toEqual([]);
  expect(webUiCandidates(container({ports:[{host:8443,container:443,protocol:'tcp'}],labels:{'talome.ui.port':'443','talome.ui.protocol':'http'}}))[0]?.protocol).toBe('http');
 });
 it('rejects JSON APIs and error pages, recognizes actual HTML forms/app shells', () => {
  expect(browserPageTitle(200,'application/json','{"status":"ok"}')).toBeUndefined();
  expect(browserPageTitle(404,'text/html','<title>Error</title><script></script>')).toBeUndefined();
  expect(browserPageTitle(200,'text/html','<title>qBittorrent WebUI</title><form></form>')).toBe('qBittorrent WebUI');
 });
 it('detects a real local HTML interface through a local login redirect without sending cookies', async () => {
  const paths: string[] = [];
  const port = await server((req,res) => { paths.push(req.url!); expect(req.headers.cookie).toBeUndefined(); if(req.url==='/'){res.writeHead(302,{location:'/login'});res.end();}else{res.setHeader('content-type','text/html');res.end('<title>Mailpit</title><form></form>');} });
  expect(await probeWebUi({port,protocol:'http',path:'/',source:'detected'})).toMatchObject({title:'Mailpit',port});
  expect(paths).toEqual(['/','/login']);
 });
 it('does not follow an external redirect or accept a real JSON endpoint', async () => {
  const port = await server((req,res) => { if(req.url==='/redirect'){res.writeHead(302,{location:'http://example.invalid/'});res.end();}else{res.setHeader('content-type','application/json');res.end('{"status":"ok"}');} });
  expect(await probeWebUi({port,protocol:'http',path:'/redirect',source:'detected'})).toBeNull();
  expect(await probeWebUi({port,protocol:'http',path:'/',source:'detected'})).toBeNull();
 });
 it('bounds a stalled HTTP connection', async () => {
  const port = await server(() => {});
  expect(await probeWebUi({port,protocol:'http',path:'/',source:'detected'})).toBeNull();
 });
 it('caches and deduplicates discovery, retries negatives and invalidates changed ports', async () => {
  let clock = 0; const probe = vi.fn().mockResolvedValue(null); const discover = createWebUiDiscovery(probe, () => clock);
  await Promise.all([discover([container()]),discover([container()])]); expect(probe).toHaveBeenCalledTimes(1);
  clock = 30_001; await discover([container()]); expect(probe).toHaveBeenCalledTimes(2);
  await discover([container({ports:[{host:3333,container:3000,protocol:'tcp'}]})]); expect(probe).toHaveBeenCalledTimes(3);
 });
 it('keeps failed discovery out of launchers and supports explicit configuration without probing', async () => {
  const probe = vi.fn().mockRejectedValue(new Error('offline')); const discover = createWebUiDiscovery(probe);
  expect((await discover([container()]))[0].webUi).toBeNull();
  expect((await discover([container({labels:{'talome.ui.port':'3000'}})]))[0].webUi?.source).toBe('configured');
  expect(probe).toHaveBeenCalledTimes(1);
 });
});
