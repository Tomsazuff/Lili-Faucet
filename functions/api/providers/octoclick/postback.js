export async function onRequestPost(context) {
  return context.env.LILI_API.fetch(context.request);
}
