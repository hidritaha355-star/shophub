const json = (data, status = 200) => new Response(JSON.stringify(data), {status, headers: {"Content-Type":"application/json; charset=utf-8","Cache-Control":"no-store"}});
export async function onRequestGet({env}) {
  if (!env.SHOPHUB_DB) return json({error:"Product database is not configured."},503);
  try {
    const {results=[]} = await env.SHOPHUB_DB.prepare("SELECT id,name,description,price,currency,category,image_url,checkout_url FROM products WHERE active=1 ORDER BY id DESC").all();
    return json({products:results});
  } catch { return json({error:"Could not load products."},500); }
}
