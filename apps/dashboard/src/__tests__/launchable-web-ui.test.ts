import { describe, expect, it } from 'vitest';
import type { Container, ServiceStack } from '@talome/types';
import { extractLaunchableApps } from '@/components/widgets/launcher-widget';
import { getContainerWebPort } from '@/lib/container-web-port';
const c = (extra: Partial<Container>): Container => ({id:'container-id',name:'container',image:'example:latest',status:'running',created:'',labels:{},ports:[],...extra});
const s = (containers: Container[], extra: Partial<ServiceStack> = {}): ServiceStack => ({id:'stack',name:'stack',kind:'compose',status:'running',containers,primaryContainer:containers[0],cpuPercent:0,memoryUsageMb:0,runningCount:containers.length,totalCount:containers.length,...extra});
describe('launchable browser interfaces', () => {
 it('excludes database and API ports even when they are published', () => {
  const db=c({name:'postgres',ports:[{host:54322,container:5432,protocol:'tcp'}]});
  const api=c({id:'api',name:'gateway',ports:[{host:8080,container:8080,protocol:'tcp'}],webUi:null});
  expect(getContainerWebPort(db)).toBeUndefined();
  expect(extractLaunchableApps([s([db,api])])).toEqual([]);
 });
 it('names a UI exposed by Gluetun for qBittorrent and preserves stable launch identity', () => {
  const vpn=c({name:'gluetun-vpn',image:'qmcgaw/gluetun:latest',webUi:{port:8080,protocol:'http',path:'/',title:'qBittorrent WebUI',source:'detected'}});
  const qbit=c({id:'qbit-id',name:'qbittorrent'});
  expect(extractLaunchableApps([s([vpn,qbit],{containerIcons:{'container-id':{name:'Gluetun',icon:'vpn'},'qbit-id':{name:'qBittorrent',iconUrl:'/qbit.png'}}})])[0]).toMatchObject({id:'gluetun-vpn',name:'qBittorrent',iconUrl:'/qbit.png',url:'http://localhost:8080/'});
 });
 it('retains configured protocol/path/name and does not launch stopped interfaces', () => {
  const app=c({webUi:{port:9443,protocol:'https',path:'/admin',title:'My App',source:'configured'}});
  expect(extractLaunchableApps([s([app])])[0]).toMatchObject({name:'My App',url:'https://localhost:9443/admin'});
  expect(extractLaunchableApps([s([{...app,status:'stopped'}])])).toEqual([]);
 });
});
