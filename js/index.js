var mn = ;
    mns = ;
    hdr = ;

$(window).scroll(function() {
  if( $(this).scrollTop() > $('header').height() ) {
    $(".main-nav").addClass(("main-nav-scrolled"));
  } else {
    $(".main-nav").removeClass(("main-nav-scrolled"));
  }
});