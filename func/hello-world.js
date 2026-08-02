export default function hello_world (req, res) {
  console.log('running route from custom function...')
  console.log(req.url)
  return 0
}