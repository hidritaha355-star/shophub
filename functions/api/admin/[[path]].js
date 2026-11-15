const json=(data,status=200,headers={})=>new Response(JSON.stringify(data),{status,headers:{"Content-Type":"application/json; charset=utf-8","Cache-Control":"no-store",...headers}});
const enc=s=>new TextEncoder().encode(s);
const b64=b=>btoa(String.fromCharCode(...new Uint8Array(b)));
const b64u=b=>b64(b).replaceAll("=","").replaceAll("+","-").replaceAll("/","_");
async function digest(s){return b64u(await crypto.subtle.digest("SHA-256",enc(s)));}
function cookie(req){const part=(req.headers.get("Cookie")||"").split(";").map(x=>x.trim()).find(x=>x.startsWith("shophub_admin="));return part?decodeURIComponent(part.slice("shophub_admin=".length)):"";}
async function adminSession(req,env){
 const token=cookie(req);if(!token)return false;
 const hash=await digest(token),now=Math.floor(Date.now()/1000);
 const row=await env.SHOPHUB_DB.prepare("SELECT token_hash FROM sessions WHERE token_hash=? AND expires_at>?").bind(hash,now).first();
 return !!row;
}
async function verifyPassword(password,admin){
 const key=await crypto.subtle.importKey("raw",enc(password),"PBKDF2",false,["deriveBits"]);
 const bits=await crypto.subtle.deriveBits({name:"PBKDF2",salt:Uint8Array.from(atob(admin.salt),c=>c.charCodeAt(0)),iterations:admin.iterations,hash:"SHA-256"},key,256);
 return b64(bits)===admin.password_hash;
}
async function readBody(req){const raw=await req.text();if(raw.length>20000)throw new Error("Request too large");return JSON.parse(raw||"{}");}
function cleanProduct(b){
 const name=String(b.name||"").trim(),description=String(b.description||"").trim(),checkout=String(b.checkout_url||"").trim();
 const price=Number(b.price),currency=String(b.currency||"USD").trim().toUpperCase(),category=String(b.category||"Other").trim().slice(0,40),image=String(b.image_url||"").trim();
 if(!name||name.length>120)throw new Error("Name is required (max 120 characters).");
 if(!Number.isFinite(price)||price<0||price>1000000)throw new Error("Enter a valid price.");
 if(!checkout.startsWith("https://")||checkout.length>1000)throw new Error("A valid HTTPS checkout link is required.");
 if(image&&!image.startsWith("https://")&&!image.startsWith("data:image/")&&image.length>12)throw new Error("Image must be an HTTPS URL or a short emoji.");
 return {name,description:description.slice(0,2000),price,currency:/^[A-Z]{3}$/.test(currency)?currency:"USD",category,image_url:image.slice(0,1000),checkout_url:checkout};
}
export async function onRequest({request,env}){
 if(!env.SHOPHUB_DB)return json({error:"Database binding is missing."},503);
 let path=new URL(request.url).pathname;if(path.endsWith("/"))path=path.slice(0,-1);
 try {
  if(path==="/api/admin/login"&&request.method==="POST"){
   const body=await readBody(request),ip=request.headers.get("CF-Connecting-IP")||"unknown",ipHash=await digest(ip),now=Math.floor(Date.now()/1000);
   const attempt=await env.SHOPHUB_DB.prepare("SELECT count,window_start FROM login_attempts WHERE ip_hash=?").bind(ipHash).first();
   if(attempt&&attempt.window_start>now-900&&attempt.count>=6)return json({error:"Too many attempts. Try again in 15 minutes."},429);
   const admin=await env.SHOPHUB_DB.prepare("SELECT salt,password_hash,iterations FROM admins WHERE id=1").first();
   const ok=admin&&typeof body.password==="string"&&body.password.length<=200&&await verifyPassword(body.password,admin);
   if(!ok){
    await env.SHOPHUB_DB.prepare("INSERT INTO login_attempts(ip_hash,count,window_start) VALUES(?,1,?) ON CONFLICT(ip_hash) DO UPDATE SET count=CASE WHEN window_start<? THEN 1 ELSE count+1 END,window_start=CASE WHEN window_start<? THEN excluded.window_start ELSE window_start END").bind(ipHash,now,now-900,now-900).run();
    return json({error:"Incorrect password."},401);
   }
   await env.SHOPHUB_DB.prepare("DELETE FROM login_attempts WHERE ip_hash=?").bind(ipHash).run();
   const bytes=crypto.getRandomValues(new Uint8Array(32)),token=b64u(bytes),hash=await digest(token),expires=now+43200;
   await env.SHOPHUB_DB.prepare("INSERT INTO sessions(token_hash,expires_at) VALUES(?,?)").bind(hash,expires).run();
   return json({ok:true},200,{"Set-Cookie":"shophub_admin="+token+"; Path=/api/admin; HttpOnly; Secure; SameSite=Strict; Max-Age=43200"});
  }
  if(path==="/api/admin/logout"&&request.method==="POST"){
   const token=cookie(request);if(token)await env.SHOPHUB_DB.prepare("DELETE FROM sessions WHERE token_hash=?").bind(await digest(token)).run();
   return json({ok:true},200,{"Set-Cookie":"shophub_admin=; Path=/api/admin; HttpOnly; Secure; SameSite=Strict; Max-Age=0"});
  }
  if(!await adminSession(request,env))return json({error:"Unauthorized."},401);
  if(path==="/api/admin/products"&&request.method==="GET"){
   const {results=[]}=await env.SHOPHUB_DB.prepare("SELECT id,name,description,price,currency,category,image_url,checkout_url,active FROM products ORDER BY id DESC").all();
   return json({products:results});
  }
  if(path==="/api/admin/products"&&request.method==="POST"){
   const p=cleanProduct(await readBody(request));
   const r=await env.SHOPHUB_DB.prepare("INSERT INTO products(name,description,price,currency,category,image_url,checkout_url,active) VALUES(?,?,?,?,?,?,?,1)").bind(p.name,p.description,p.price,p.currency,p.category,p.image_url,p.checkout_url).run();
   return json({ok:true,id:r.meta.last_row_id},201);
  }
  const parts=path.split("/");
  const productId=parts.length===5&&parts[1]==="api"&&parts[2]==="admin"&&parts[3]==="products"&&/^[0-9]+$/.test(parts[4])?Number(parts[4]):0;
  if(productId&&request.method==="PUT"){
   const p=cleanProduct(await readBody(request));
   await env.SHOPHUB_DB.prepare("UPDATE products SET name=?,description=?,price=?,currency=?,category=?,image_url=?,checkout_url=?,updated_at=CURRENT_TIMESTAMP WHERE id=?").bind(p.name,p.description,p.price,p.currency,p.category,p.image_url,p.checkout_url,productId).run();
   return json({ok:true});
  }
  if(productId&&request.method==="DELETE"){
   await env.SHOPHUB_DB.prepare("UPDATE products SET active=0,updated_at=CURRENT_TIMESTAMP WHERE id=?").bind(productId).run();
   return json({ok:true});
  }
  return json({error:"Not found."},404);
 }catch(e){console.error("ShopHub admin API failure", {path,method:request.method,error:e?.message||String(e),stack:e?.stack});const detail=String(e?.message||e).replace(/[\\r\\n]/g," ").slice(0,180);return json({error:path==="/api/admin/login"?"Login diagnostic: "+detail:(e.message==="Request too large"?e.message:"Invalid request or database error.")},400);}
}
