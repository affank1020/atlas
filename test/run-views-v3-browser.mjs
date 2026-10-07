// Temporary real-browser fixture. Runs the production server against an isolated schema.
import {writeFile} from 'node:fs/promises';
import {databaseFixture,cleanupDatabases} from '../dist/test/database.js';
import {universityFixture} from '../dist/test/views-v3-fixture.js';
import {createAtlasHttpServer} from '../dist/src/server.js';
const fixture=await databaseFixture();const data=await universityFixture(fixture.catalog);
const server=createAtlasHttpServer({databaseUrl:fixture.databaseUrl});
const path=`/projects/${data.project.id}/views/${data.view.slug}`;
await writeFile('/tmp/atlas-v3-browser-fixture.json',JSON.stringify({projectId:data.project.id,viewId:data.view.id,first:data.first,second:data.second,url:'http://127.0.0.1:3001'+path},null,2));
server.listen(3001,'127.0.0.1',()=>console.log('Browser fixture: http://127.0.0.1:3001'+path));
const stop=()=>server.close(async()=>{await cleanupDatabases();process.exit(0)});
process.on('SIGINT',stop);process.on('SIGTERM',stop);
