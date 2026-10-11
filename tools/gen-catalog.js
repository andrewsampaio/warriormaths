// Genera src/catalog.json a partir de los datos del juego (precios de la tienda y de la guarida)
const fs=require('fs'), vm=require('vm'), path=require('path');
const src=fs.readFileSync(process.argv[2]||path.join(__dirname,'../../game5/src/state.js'),'utf8');
const ctx={window:{},navigator:{language:"es"},document:{documentElement:{},querySelector:()=>null},localStorage:{getItem(){return null},setItem(){}},structuredClone,console};
const out=vm.runInNewContext(src+"\n;({ITEMS,PRICES,FREE,CH})",ctx);
const items={};
for(const it of out.ITEMS) items[it.id]={price:it.price,slot:it.slot,kind:it.kind==="consumable"?"consumable":"acc",name:it.name};
for(const [id,price] of Object.entries(out.PRICES)) items[id]={price,slot:"look",kind:"look",name:id};
const gifts=Object.values(out.CH).map(c=>c.gift).filter(Boolean);
fs.writeFileSync(path.join(__dirname,'../src/catalog.json'),JSON.stringify({items,free:out.FREE,gifts},null,1));
console.log('catalog items',Object.keys(items).length,'gifts',gifts);
