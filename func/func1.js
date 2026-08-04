export default function func1 (req, res) {
  console.log('running route from custom function...')
  console.log(req.url)
  return 0
}