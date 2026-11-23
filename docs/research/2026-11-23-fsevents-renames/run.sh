#!/bin/sh
D=$1; W=$(cd $D/w && pwd -P); cd $W || exit 1
git init -q . && mkdir -p img sub && echo a > img/a.png && echo c > ch.gm && echo x > keep.gm && git add -A && git -c user.email=x@x -c user.name=x commit -qm init
$D/probe $W 7 > $D/out.txt &
P=$!
perl -e 'select(undef,undef,undef,1.0)'
echo "--- mv file" >> $D/marks; mv img/a.png sub/a.png
perl -e 'select(undef,undef,undef,0.6)'
git mv ch.gm sub/ch.gm
perl -e 'select(undef,undef,undef,0.6)'
mv sub moved
perl -e 'select(undef,undef,undef,0.6)'
printf y > .keep.tmp && mv .keep.tmp keep.gm
perl -e 'select(undef,undef,undef,0.6)'
mv keep.gm keep.gm~ && printf z > keep.gm && rm keep.gm~
perl -e 'select(undef,undef,undef,0.6)'
mv moved/ch.gm moved/CH.gm
perl -e "select(undef,undef,undef,0.6)"
printf k > がぎ.gm && perl -e "select(undef,undef,undef,0.6)" && mv がぎ.gm moved/ぐげ.gm && ls moved | od -c | head -3
wait $P
cat $D/out.txt
